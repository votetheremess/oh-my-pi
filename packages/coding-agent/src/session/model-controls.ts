import { type Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model, ProviderSessionState, ServiceTier, ServiceTierByFamily, ServiceTierFamily } from "@oh-my-pi/pi-ai";
import {
	Effort,
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	serviceTierFamily,
	shouldSendServiceTier,
} from "@oh-my-pi/pi-ai";
import {
	clearAnthropicFastModeFallback,
	isAnthropicFastModeFallbackDisabled,
} from "@oh-my-pi/pi-ai/providers/anthropic-state";
import { isFireworksFastModelId } from "@oh-my-pi/pi-catalog/fireworks-model-id";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import { classifyDifficulty } from "../auto-thinking/classifier";
import type { ModelRegistry } from "../config/model-registry";
import {
	filterAvailableModelsByEnabledPatterns,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	type ResolvedModelRoleValue,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { getKnownRoleIds } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { containsMagicKeyword } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import type { MagicKeywordId } from "../modes/magic-keywords";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	clampAutoThinkingEffort,
	clampThinkingLevelToCeiling,
	parseConfiguredThinkingLevel,
	resolveProvisionalAutoLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
	ultracodeEffortFor,
} from "@oh-my-pi/pi-tui/thinking";
import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import type { AgentSessionEvent } from "./agent-session-events";
import type { ModelCycleResult, ResolvedRoleModel, RoleModelCycle, RoleModelCycleResult } from "./agent-session-types";
import { formatRoleModelValue, resolveRoleModelFull } from "./role-models";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "./session-entries";
import type { SessionManager } from "./session-manager";

import { cfgDefaultThinkingLevel, cfgProvidersFireworksTier } from "./settings";
import { cfgDisabledProviders, cfgEnabledModels } from "../config/model-settings";
import { cfgUltracode } from "../modes/settings";

/** Capabilities borrowed from the owning AgentSession. */
export interface ModelControlsHost {
	agent: Agent;
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionManager: SessionManager;
	providerSessionState: Map<string, ProviderSessionState>;
	model(): Model | undefined;
	sessionId(): string;
	promptGeneration(): number;
	resolveActiveEditMode(): EditMode;
	syncAfterModelChange(previousEditMode: EditMode): Promise<void>;
	setModelWithProviderSessionReset(model: Model, selection?: "explicit" | "automatic"): Promise<void>;
	clearActiveRetryFallback(): void;
	clearInheritedProviderPromptCacheKey(): void;
	magicKeywordEnabled(keyword: MagicKeywordId): boolean;
	emit(event: AgentSessionEvent): void;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
}

/** Owns model selection, thinking effort, role cycling, and service tiers. */
export class ModelControls {
	readonly #host: ModelControlsHost;
	#scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	#thinkingLevel: ThinkingLevel | undefined;
	/**
	 * Hard per-session effort ceiling (e.g. a task spawn's `task.maxEffort` cap); recovery paths re-clamp to it.
	 * Mutable only for a session born armed: its spawn-time ceiling is the pin's (xhigh), and the hand-back
	 * swaps in {@link #ultracodeRestoreCeiling}, the ceiling it would have had unpinned.
	 */
	#thinkingLevelCeiling: Effort | undefined;
	/**
	 * The ceiling a session born armed hands back to when its pin ends (`null` = no ceiling). `undefined`
	 * means "keep the current ceiling": not born armed, unknown (legacy transcript), or already applied.
	 */
	#ultracodeRestoreCeiling: Effort | null | undefined;
	/**
	 * `configured` receipt of the last thinking entry this instance wrote, when it differs from the level it
	 * recorded (only an ultracode pin's borrowed-FROM receipt does). A later write of the same level with a
	 * different receipt is then still a change: otherwise the transcript keeps the pin's receipt and a resume
	 * discards the user's explicit choice of the pinned level.
	 */
	#divergentReceipt: ConfiguredThinkingLevel | undefined;
	#autoThinking = false;
	#autoResolvedLevel: Effort | undefined;
	/**
	 * Level to hand back once the ultracode turn ends, captured before the pin.
	 * `undefined` means no ultracode turn is in flight, which is the common case.
	 * The USER's level, never the borrowed xhigh: every "what does the user
	 * want" read goes through {@link userConfiguredThinkingLevel}.
	 */
	#levelBeforeUltracode: ConfiguredThinkingLevel | undefined;
	#serviceTierByFamily: ServiceTierByFamily;

	constructor(
		host: ModelControlsHost,
		options: {
			scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
			thinkingLevel?: ConfiguredThinkingLevel;
			thinkingLevelCeiling?: Effort;
			/**
			 * Seeds the ultracode handback. A child constructed directly at xhigh
			 * under an armed parent never runs {@link beginUltracodeTurn}, so it has
			 * no capture of its own: this is how it learns what to hand back when
			 * the parent's turn ends and the lifecycle sync disarms it.
			 */
			ultracodeRestoreLevel?: ConfiguredThinkingLevel;
			/**
			 * The ceiling a session born armed would have had unpinned, applied when its pin hands back.
			 * `null` = no ceiling; `undefined` = unknown (legacy transcript): keep the current ceiling.
			 */
			ultracodeRestoreCeiling?: Effort | null;
			serviceTierByFamily?: ServiceTierByFamily;
		},
	) {
		this.#host = host;
		this.#scopedModels = options.scopedModels ?? [];
		this.#serviceTierByFamily = options.serviceTierByFamily ?? {};
		this.#thinkingLevelCeiling = options.thinkingLevelCeiling;
		// Only meaningful for a session born armed: `#levelBeforeUltracode` set
		// means "a pin is borrowed", so an unarmed session must never carry one.
		const bornArmed = cfgUltracode.get(host.settings);
		this.#ultracodeRestoreCeiling = bornArmed ? options.ultracodeRestoreCeiling : undefined;
		// A session born AT the pin with no hand-back level (a level-less agent
		// definition, a legacy transcript, an auxiliary spawn) would otherwise keep
		// the borrowed xhigh as its own level once disarmed. Fall back to what it
		// would have started at unpinned. Born armed but NOT at the pin (a root
		// whose flag was persisted by hand) was never pinned: no hand-back.
		this.#levelBeforeUltracode = !bornArmed
			? undefined
			: (options.ultracodeRestoreLevel ??
				(options.thinkingLevel === Effort.XHigh
					? (this.#model?.thinking?.defaultLevel ??
						parseConfiguredThinkingLevel(cfgDefaultThinkingLevel.get(host.settings)) ??
						ThinkingLevel.Off)
					: undefined));
		if (options.thinkingLevel === AUTO_THINKING) {
			// Keep auto pending until the first turn while exposing a valid wire effort.
			this.#autoThinking = true;
			this.#thinkingLevel = clampThinkingLevelToCeiling(
				this.#model,
				resolveProvisionalAutoLevel(this.#model),
				this.#thinkingLevelCeiling,
			);
		} else {
			this.#thinkingLevel = clampThinkingLevelToCeiling(
				this.#model,
				options.thinkingLevel,
				this.#thinkingLevelCeiling,
			);
		}
		this.#applyThinkingLevelToAgent(this.#thinkingLevel);
	}

	get #model(): Model | undefined {
		return this.#host.model();
	}

	/** Effective metadata-clamped thinking level applied to the agent. */
	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#thinkingLevel;
	}

	/** Hard per-session effort ceiling every thinking-level change is clamped to. */
	get thinkingLevelCeiling(): Effort | undefined {
		return this.#thinkingLevelCeiling;
	}

	/** Configured selector, preserving `auto` while classification is active. */
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#autoThinking ? AUTO_THINKING : this.#thinkingLevel;
	}

	/**
	 * The level the USER owns: the pre-pin capture while an ultracode turn is in
	 * flight, else the live selector. Persistence, revert, and handback paths
	 * must read this rather than {@link configuredThinkingLevel}, which reports
	 * the borrowed xhigh mid-turn and would record the pin as the user's choice.
	 */
	userConfiguredThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#levelBeforeUltracode ?? this.configuredThinkingLevel();
	}

	/** Whether per-turn automatic thinking classification is enabled. */
	get isAutoThinking(): boolean {
		return this.#autoThinking;
	}

	/** Last concrete effort selected by automatic classification. */
	get autoResolvedThinkingLevel(): Effort | undefined {
		return this.#autoResolvedLevel;
	}

	/** Models explicitly scoped to the session's cycle command, minus currently disabled providers. */
	get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }> {
		const disabledProviders = cfgDisabledProviders.get(this.#host.settings);
		if (disabledProviders.length === 0) return this.#scopedModels;
		return this.#scopedModels.filter(scoped => !disabledProviders.includes(scoped.model.provider));
	}

	/**
	 * Replace the Ctrl+P cycle scope. Startup resolves the scope before background
	 * provider discovery runs; the CLI re-pushes the fuller list here once discovery
	 * completes so a newly-discovered `enabledModels` model joins the cycle and the
	 * scoped `/models` picker (issue #9220).
	 */
	setScopedModels(scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>): void {
		this.#scopedModels = scopedModels;
	}

	/** Live per-provider-family service-tier selection. */
	get serviceTierByFamily(): ServiceTierByFamily {
		return this.#serviceTierByFamily;
	}

	/** Restores thinking state from a transcript without persisting a new entry. */
	restoreThinkingLevel(level: ConfiguredThinkingLevel | undefined): void {
		this.#autoThinking = level === AUTO_THINKING;
		this.#autoResolvedLevel = undefined;
		this.#thinkingLevel =
			level === AUTO_THINKING
				? clampThinkingLevelToCeiling(
						this.#model,
						resolveProvisionalAutoLevel(this.#model),
						this.#thinkingLevelCeiling,
					)
				: resolveThinkingLevelForModel(
						this.#model,
						clampThinkingLevelToCeiling(this.#model, level, this.#thinkingLevelCeiling),
					);
		this.#applyThinkingLevelToAgent(this.#thinkingLevel);
		// The restored transcript's receipt is what it is; nothing this instance wrote applies to it.
		this.#divergentReceipt = undefined;
	}

	/** Restores an exact thinking snapshot after a failed session switch. */
	restoreThinkingSnapshot(level: ThinkingLevel | undefined, auto: boolean, resolved: Effort | undefined): void {
		this.#thinkingLevel = level;
		this.#autoThinking = auto;
		this.#autoResolvedLevel = resolved;
		this.#applyThinkingLevelToAgent(level);
	}

	/** Restores service tiers without persisting a duplicate transcript entry. */
	restoreServiceTiers(tiers: ServiceTierByFamily): void {
		this.#serviceTierByFamily = tiers;
	}
	resolveRoleModel(role: string): Model | undefined {
		return resolveRoleModelFull(this.#host.settings, role, this.#host.modelRegistry.getAvailable(), this.#model)
			.model;
	}

	resolveRoleModelWithThinking(role: string): ResolvedModelRoleValue {
		return resolveRoleModelFull(this.#host.settings, role, this.#host.modelRegistry.getAvailable(), this.#model);
	}

	resolveTemporaryModelThinkingLevel(model: Model): ConfiguredThinkingLevel | undefined {
		const availableModels = this.#host.modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const matchPreferences = getModelMatchPreferences(this.#host.settings);
		for (const role of getKnownRoleIds(this.#host.settings)) {
			const roleValue = this.#host.settings.getModelRole(role);
			if (!roleValue) continue;

			const resolved = resolveModelRoleValue(roleValue, availableModels, {
				settings: this.#host.settings,
				matchPreferences,
			});
			if (!resolved.explicitThinkingLevel || resolved.thinkingLevel === undefined || !resolved.model) continue;
			if (modelsAreEqual(resolved.model, model)) return resolved.thinkingLevel;
		}

		return undefined;
	}

	async setModel(
		model: Model,
		role: string = "default",
		options?: {
			selector?: string;
			thinkingLevel?: ThinkingLevel;
			persist?: boolean;
		},
	): Promise<{ switched: boolean }> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		if (!this.#host.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const targetModel = await this.#host.modelRegistry.refreshSelectedModelMetadata(model);

		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(targetModel));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(targetModel);
		this.#host.sessionManager.appendModelChange(`${targetModel.provider}/${targetModel.id}`, role);
		if (options?.persist) {
			this.#host.settings.setModelRole(
				role,
				formatRoleModelValue(
					this.#host.settings,
					this.#host.modelRegistry,
					role,
					targetModel,
					options.selector,
					options.thinkingLevel,
				),
			);
		}
		this.#host.settings.getStorage()?.recordModelUsage(`${targetModel.provider}/${targetModel.id}`);

		// Re-apply thinking for the newly selected model. Prefer the model's
		// configured defaultLevel; otherwise preserve the current level (or auto).
		this.#reapplyThinkingLevel(targetModel.thinking?.defaultLevel);
		this.repinUltracodeIfArmed();
		await this.#host.syncAfterModelChange(previousEditMode);
		return { switched: true };
	}

	/**
	 * Set model temporarily (for this session only).
	 * Validates that a credential source is configured (synchronously, without
	 * refreshing OAuth or running command-backed key programs), saves to session
	 * log but NOT to settings.
	 * @throws Error if no API key available for the model
	 */
	async setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
		selection: "explicit" | "automatic" = "explicit",
	): Promise<void> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		if (!this.#host.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const targetModel = await this.#host.modelRegistry.refreshSelectedModelMetadata(model);

		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(targetModel));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(targetModel, selection);
		this.#host.sessionManager.appendModelChange(
			`${targetModel.provider}/${targetModel.id}`,
			options?.ephemeral ? EPHEMERAL_MODEL_CHANGE_ROLE : "temporary",
		);
		this.#host.settings.getStorage()?.recordModelUsage(`${targetModel.provider}/${targetModel.id}`);

		// Apply explicit thinking level if given; otherwise prefer the model's
		// configured defaultLevel; otherwise re-clamp the current level (or auto).
		if (thinkingLevel !== undefined) {
			this.setThinkingLevel(thinkingLevel);
			// An internal swap that carries its own level (prewalk hand-off,
			// plan-yolo, deferred plan-model switch) is where the session would be
			// without the keyword, so an armed turn hands back to it.
			this.rebaseUltracodeRestore();
		} else {
			this.#reapplyThinkingLevel(targetModel.thinking?.defaultLevel);
		}
		this.repinUltracodeIfArmed();
		await this.#host.syncAfterModelChange(previousEditMode);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.scopedModels.length > 0) {
			return this.#cycleScopedModel(direction);
		}
		return this.#cycleAvailableModel(direction);
	}

	/**
	 * Resolve the configured role models in the given order plus the index of
	 * the currently active one. Roles that have no configured model, or whose
	 * configured model is not currently available, are skipped. The `default`
	 * role falls back to the active model when no explicit assignment exists.
	 *
	 * Returns `undefined` only when there is no current model or no available
	 * models at all; an empty `models` array is never returned (callers should
	 * still guard on `models.length`).
	 */
	getRoleModelCycle(roleOrder: readonly string[]): RoleModelCycle | undefined {
		const availableModels = this.#host.modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const currentModel = this.#model;
		if (!currentModel) return undefined;
		const matchPreferences = getModelMatchPreferences(this.#host.settings);
		const models: ResolvedRoleModel[] = [];

		for (const role of roleOrder) {
			const roleModelStr =
				role === "default"
					? (this.#host.settings.getModelRole("default") ?? `${currentModel.provider}/${currentModel.id}`)
					: this.#host.settings.getModelRole(role);
			if (!roleModelStr) continue;

			const resolved = resolveModelRoleValue(roleModelStr, availableModels, {
				settings: this.#host.settings,
				matchPreferences,
			});
			if (!resolved.model) continue;

			models.push({
				role,
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
			});
		}

		if (models.length === 0) return undefined;

		// Trust the recorded role only while its resolved model still IS the
		// active model. A model switch through another surface (alt+m, retry
		// fallback, /model) or a role re-configuration leaves the recorded role
		// pointing at a model the session no longer runs; cycling from that
		// stale slot lands on the wrong neighbor and reads as a skipped entry.
		const lastRole = this.#host.sessionManager.getLastModelChangeRole();
		let currentIndex = lastRole ? models.findIndex(entry => entry.role === lastRole) : -1;
		if (currentIndex !== -1 && !modelsAreEqual(models[currentIndex].model, currentModel)) {
			currentIndex = -1;
		}
		if (currentIndex === -1) {
			currentIndex = models.findIndex(entry => modelsAreEqual(entry.model, currentModel));
		}
		if (currentIndex === -1) currentIndex = 0;

		return { models, currentIndex };
	}

	/**
	 * Apply a resolved role model as the active model without changing global
	 * settings. Shared with role cycling and the plan-approval model slider.
	 *
	 * An armed ultracode turn re-pins AFTER the role's own `:level` lands: the
	 * role selector describes the model's everyday effort, and the keyword
	 * outranks it for exactly this turn.
	 */
	async applyRoleModel(entry: ResolvedRoleModel): Promise<void> {
		await this.setModel(entry.model, entry.role);
		if (entry.explicitThinkingLevel && entry.thinkingLevel !== undefined) {
			this.setThinkingLevel(entry.thinkingLevel);
			this.repinUltracodeIfArmed();
		}
	}

	/**
	 * Cycle through configured role models in a fixed order.
	 * Skips missing roles and changes only the active session model.
	 * @param roleOrder - Order of roles to cycle through (e.g., ["slow", "default", "smol"])
	 * @param direction - "forward" (default) or "backward"
	 */
	async cycleRoleModels(
		roleOrder: readonly string[],
		direction: "forward" | "backward" = "forward",
	): Promise<RoleModelCycleResult | undefined> {
		const cycle = this.getRoleModelCycle(roleOrder);
		if (!cycle || cycle.models.length <= 1) return undefined;

		const step = direction === "backward" ? -1 : 1;
		const next = cycle.models[(cycle.currentIndex + step + cycle.models.length) % cycle.models.length];

		await this.applyRoleModel(next);

		return { model: next.model, thinkingLevel: this.thinkingLevel, role: next.role };
	}

	async #getScopedModelsWithApiKey(): Promise<Array<{ model: Model; thinkingLevel?: ThinkingLevel }>> {
		const apiKeysByProvider = new Map<string, string | undefined>();
		const result: Array<{ model: Model; thinkingLevel?: ThinkingLevel }> = [];

		for (const scoped of this.scopedModels) {
			const provider = scoped.model.provider;
			let apiKey: string | undefined;
			if (apiKeysByProvider.has(provider)) {
				apiKey = apiKeysByProvider.get(provider);
			} else {
				apiKey = await this.#host.modelRegistry.getApiKeyForProvider(provider, this.#host.sessionId());
				apiKeysByProvider.set(provider, apiKey);
			}

			if (apiKey) {
				result.push(scoped);
			}
		}

		return result;
	}

	async #cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		const scopedModels = await this.#getScopedModelsWithApiKey();
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.#model;
		let currentIndex = scopedModels.findIndex(sm => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];

		// Apply model
		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(next.model));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(next.model);
		this.#host.sessionManager.appendModelChange(`${next.model.provider}/${next.model.id}`);
		this.#host.settings.getStorage()?.recordModelUsage(`${next.model.provider}/${next.model.id}`);

		// Apply the scoped model's configured thinking level, preserving auto.
		this.setThinkingLevel(this.#autoThinking ? AUTO_THINKING : next.thinkingLevel);
		this.repinUltracodeIfArmed();
		await this.#host.syncAfterModelChange(previousEditMode);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	async #cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		const availableModels = this.#host.modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.#model;
		let currentIndex = availableModels.findIndex(m => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const apiKey = await this.#host.modelRegistry.getApiKey(nextModel, this.#host.sessionId());
		if (!apiKey) {
			throw new Error(`No API key for ${nextModel.provider}/${nextModel.id}`);
		}

		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(nextModel));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(nextModel);
		this.#host.sessionManager.appendModelChange(`${nextModel.provider}/${nextModel.id}`);
		this.#host.settings.getStorage()?.recordModelUsage(`${nextModel.provider}/${nextModel.id}`);
		// Re-apply the current thinking level (or auto) for the newly selected model
		this.#reapplyThinkingLevel();
		this.repinUltracodeIfArmed();
		await this.#host.syncAfterModelChange(previousEditMode);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	/**
	 * Get all available models with valid API keys, filtered by `enabledModels` when configured.
	 * See {@link filterAvailableModelsByEnabledPatterns} for supported pattern forms and limitations.
	 */
	getAvailableModels(): Model[] {
		const all = this.#host.modelRegistry.getAvailable();
		const patterns = cfgEnabledModels.get(this.#host.settings);
		if (!patterns || patterns.length === 0) return all;
		return filterAvailableModelsByEnabledPatterns(all, patterns, this.#host.settings);
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	#applyThinkingLevelToAgent(level: ThinkingLevel | undefined): void {
		this.#host.agent.setThinkingLevel(toReasoningEffort(level));
		this.#host.agent.setDisableReasoning(shouldDisableReasoning(level));
	}

	/**
	 * Set the thinking level. `auto` enables per-turn classification. Entering
	 * auto writes its provisional level plus `configured: "auto"` immediately,
	 * giving external readers an authoritative selection receipt before the next
	 * user turn. Later classifications persist only changed concrete resolutions.
	 *
	 * `configuredReceipt` overrides the `configured` value written to the session
	 * record for a concrete level. {@link beginUltracodeTurn} passes the
	 * borrowed-FROM level so the turn-scoped pin never becomes the session's own
	 * configured level on disk: a process killed mid-ultracode-turn must resume
	 * at the pre-ultracode level, not stranded at xhigh with no handback state.
	 */
	setThinkingLevel(
		level: ConfiguredThinkingLevel | undefined,
		persist: boolean = false,
		configuredReceipt?: ConfiguredThinkingLevel,
	): void {
		if (level === AUTO_THINKING) {
			const provisional = clampThinkingLevelToCeiling(
				this.#model,
				resolveProvisionalAutoLevel(this.#model),
				this.#thinkingLevelCeiling,
			);
			const wasAuto = this.#autoThinking;
			const previousLevel = this.#thinkingLevel;
			this.#autoThinking = true;
			this.#autoResolvedLevel = undefined;
			this.#thinkingLevel = provisional;
			if (!wasAuto) {
				this.#host.clearInheritedProviderPromptCacheKey();
			}
			this.#applyThinkingLevelToAgent(provisional);
			if (persist) {
				cfgDefaultThinkingLevel.set(this.#host.settings, AUTO_THINKING);
			}
			const isChanging = !wasAuto || previousLevel !== provisional;
			if (isChanging) {
				this.#host.sessionManager.appendThinkingLevelChange(provisional, AUTO_THINKING);
				this.#divergentReceipt = undefined;
				this.#host.emit({ type: "thinking_level_changed", thinkingLevel: provisional, configured: AUTO_THINKING });
			}
			return;
		}

		const wasAuto = this.#autoThinking;
		this.#autoThinking = false;
		this.#autoResolvedLevel = undefined;
		const effectiveLevel = resolveThinkingLevelForModel(
			this.#model,
			clampThinkingLevelToCeiling(this.#model, level, this.#thinkingLevelCeiling),
		);
		// Leaving auto must persist even when the resolved effort is unchanged (e.g.
		// auto resolved to medium, then the user pins medium): otherwise the latest
		// session entry keeps `configured: "auto"` and resume re-enables auto.
		const isChanging = wasAuto || effectiveLevel !== this.#thinkingLevel;
		// The same holds for a receipt: picking the level an ultracode pin is
		// holding must replace the pin's borrowed-FROM receipt, or a resume
		// discards the pick. The wire request is unchanged, so only the record is.
		const receipt = configuredReceipt ?? effectiveLevel;
		const receiptChanging = this.#divergentReceipt !== undefined && receipt !== this.#divergentReceipt;

		this.#thinkingLevel = effectiveLevel;
		this.#applyThinkingLevelToAgent(effectiveLevel);

		if (isChanging || receiptChanging) {
			if (isChanging) this.#host.clearInheritedProviderPromptCacheKey();
			this.#host.sessionManager.appendThinkingLevelChange(effectiveLevel, receipt);
			this.#divergentReceipt = receipt !== effectiveLevel ? receipt : undefined;
			if (persist && effectiveLevel !== undefined && effectiveLevel !== ThinkingLevel.Off) {
				cfgDefaultThinkingLevel.set(this.#host.settings, effectiveLevel);
			}
			this.#host.emit({ type: "thinking_level_changed", thinkingLevel: effectiveLevel });
		}
	}

	/**
	 * Re-apply the active thinking selection after a model change. Preserves `auto`
	 * (re-clamping the provisional level to the new model); otherwise re-applies the
	 * preferred default or the current effective level.
	 */
	#reapplyThinkingLevel(preferredDefault?: ThinkingLevel): void {
		this.setThinkingLevel(this.#autoThinking ? AUTO_THINKING : (preferredDefault ?? this.#thinkingLevel));
	}

	/** All selectable effort selectors for the active model, in cycle order. */
	getAvailableEffortSelectors(): ConfiguredThinkingLevel[] {
		if (!this.#model?.reasoning) return [];
		const efforts = this.getAvailableThinkingLevels();
		const ceiling = this.#thinkingLevelCeiling;
		const selectable =
			ceiling === undefined
				? efforts
				: efforts.filter(level => THINKING_EFFORTS.indexOf(level) <= THINKING_EFFORTS.indexOf(ceiling));
		return [ThinkingLevel.Off, AUTO_THINKING, ...selectable];
	}

	/**
	 * Cycle to next thinking level: off → auto → minimal..max → off.
	 *
	 * This is the user's own effort control, so it also takes precedence over an
	 * ultracode turn in flight. {@link beginUltracodeTurn} borrows the level and
	 * {@link endUltracodeTurn} hands it back on the next keyword-free turn, which
	 * would silently discard a level the user picked in between. Reaching for this
	 * control is an unambiguous "I want a different effort", so it drops the
	 * pending restore and keeps the choice.
	 *
	 * @returns New selector, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ConfiguredThinkingLevel | undefined {
		// Reaching for the effort control mid-ultracode-turn is an explicit choice:
		// keep it, and drop the restore that would otherwise overwrite it when the
		// turn ends. First, so a session born armed lists its unpinned selectors
		// (the off-ramp lifts the pin's xhigh ceiling): cycling on from the pinned
		// xhigh must reach max, not wrap to off. A no-op on an unarmed session.
		this.forgetUltracodeRestore();
		if (cfgUltracode.get(this.#host.settings)) cfgUltracode.override(this.#host.settings, false);
		const levels = this.getAvailableEffortSelectors();
		if (levels.length === 0) return undefined;
		const configured = this.configuredThinkingLevel();
		const currentLevel = configured === ThinkingLevel.Inherit ? ThinkingLevel.Off : configured;
		const currentIndex = currentLevel ? levels.indexOf(currentLevel) : -1;
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];
		if (!nextLevel) return undefined;

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * The exact effort an ultracode pin lands on the current model, or
	 * `undefined` when the model cannot satisfy the contract. Exactly xhigh or
	 * nothing: {@link ultracodeEffortFor} refuses ladders without the rung, and
	 * a hard `#thinkingLevelCeiling` below xhigh would make `setThinkingLevel`
	 * re-clamp the pin downward, so that is refused too rather than pinning a
	 * lower level under the ultracode name. Spawn guarantees a ceiling at or
	 * above xhigh for ultracode children, so the ceiling check only bites on a
	 * misconfigured host.
	 */
	#ultracodePinEffort(): Effort | undefined {
		return this.ultracodePinRefusal() === undefined ? ultracodeEffortFor(this.#model) : undefined;
	}

	/**
	 * Whether an ultracode pin would land on the current model: the exact
	 * predicate {@link beginUltracodeTurn} and {@link repinUltracodeIfArmed}
	 * gate on, exposed so arm/resume paths can refuse BEFORE flipping the flag.
	 */
	canPinUltracode(): boolean {
		return this.#ultracodePinEffort() !== undefined;
	}

	/**
	 * Why {@link canPinUltracode} is false, or `undefined` when it can pin.
	 * `"no-xhigh"`: the model's ladder has no xhigh rung. `"ceiling"`: the rung
	 * exists but the hard per-session ceiling would clamp the pin below it.
	 * Split so the refusal message can name the fix (swap model vs raise cap).
	 */
	ultracodePinRefusal(): "no-xhigh" | "ceiling" | undefined {
		const effort = ultracodeEffortFor(this.#model);
		if (effort === undefined) return "no-xhigh";
		return clampThinkingLevelToCeiling(this.#model, effort, this.#thinkingLevelCeiling) === effort
			? undefined
			: "ceiling";
	}

	/**
	 * Pin `effort` for the ultracode turn, capturing the level to hand back ONCE.
	 * Repeating the keyword on consecutive turns, or re-pinning after a model
	 * swap, must not overwrite the saved level with xhigh and strand the session
	 * there.
	 */
	#pinUltracode(effort: Effort): void {
		if (this.#levelBeforeUltracode === undefined) {
			this.#levelBeforeUltracode = this.configuredThinkingLevel() ?? ThinkingLevel.Off;
		}
		// The borrowed-from level is also the session record's `configured` receipt:
		// the handback state lives in process memory only, so persisting the pin as
		// the configured level would strand a killed-and-resumed session at xhigh.
		this.setThinkingLevel(effort, false, this.#levelBeforeUltracode);
	}

	/**
	 * Raise this TURN to the ultracode effort — exactly {@link Effort.XHigh} —
	 * remembering the level to hand back in {@link endUltracodeTurn}.
	 *
	 * Stronger than "ultrathink", which only biases the auto-thinking classifier
	 * and therefore does nothing at all when auto-thinking is off. Ultracode sets
	 * a concrete level, so it lands either way, and handing `setThinkingLevel` a
	 * concrete effort clears `#autoThinking` on purpose: a classifier that still
	 * runs is a classifier that can still lower the effort mid-turn.
	 *
	 * Turn-scoped, not session-scoped: the keyword steers the message that
	 * carries it and nothing after it. `setThinkingLevel` is called without
	 * `persist`, so `defaultThinkingLevel` is never rewritten.
	 *
	 * @returns true iff the pin landed. A model without an xhigh rung (including
	 * non-reasoning models and reasoning models with no effort surface) returns
	 * false and leaves the level AND the handback state untouched, so the caller
	 * can fail loudly instead of the session quietly running at the wrong effort.
	 */
	beginUltracodeTurn(): boolean {
		const effort = this.#ultracodePinEffort();
		if (effort === undefined) return false;
		this.#pinUltracode(effort);
		return true;
	}

	/**
	 * Re-apply the ultracode pin on the CURRENT model when the turn is armed.
	 * Every model swap re-applies the incoming model's default level or the
	 * selector's `:level` over the pin; internal swaps call this last so the
	 * armed turn keeps its xhigh through a fallback, cycle, or role switch.
	 *
	 * Keyed on the `ultracode` settings flag rather than `#levelBeforeUltracode`:
	 * a child session inherits the flag through the settings snapshot without
	 * ever having armed itself, and must still re-pin after a swap.
	 *
	 * @returns true iff pinned. A model without an xhigh rung leaves the level
	 * alone and returns false; the caller decides how to surface that.
	 */
	repinUltracodeIfArmed(): boolean {
		if (!cfgUltracode.get(this.#host.settings)) return false;
		const effort = this.#ultracodePinEffort();
		if (effort === undefined) return false;
		this.#pinUltracode(effort);
		return true;
	}

	/** True while a borrowed level is waiting for {@link endUltracodeTurn}. */
	hasPendingUltracodeRestore(): boolean {
		return this.#levelBeforeUltracode !== undefined;
	}

	/**
	 * Make the level just applied the pending hand-back. Capture-once keeps a
	 * re-pin from overwriting the saved level with xhigh, but an internal swap
	 * that applies a level of its own (an explicit-level temporary swap, the
	 * retry-fallback primary restore) moves where the session would be without
	 * the keyword, so the turn must hand back to THAT. Call it after the level
	 * lands and before the re-pin, which then writes it as the receipt. A no-op
	 * when nothing is pending, so unarmed sessions are untouched.
	 */
	rebaseUltracodeRestore(): void {
		if (this.#levelBeforeUltracode === undefined) return;
		this.#levelBeforeUltracode = this.configuredThinkingLevel() ?? ThinkingLevel.Off;
	}

	/**
	 * Hand back the level {@link beginUltracodeTurn} borrowed, restoring `auto`
	 * when that is what was running before. A no-op when the keyword never fired,
	 * so ordinary turns cost nothing. A session born armed also gets back the
	 * ceiling it would have had unpinned, before the level is re-clamped to it.
	 */
	endUltracodeTurn(): void {
		this.#applyUltracodeRestoreCeiling();
		const previous = this.#levelBeforeUltracode;
		if (previous === undefined) return;
		this.#levelBeforeUltracode = undefined;
		this.setThinkingLevel(previous);
	}

	/**
	 * Swap a born-armed session's spawn-time pin ceiling (xhigh) for the one it
	 * would have had unpinned, once. `null` lifts the ceiling entirely.
	 */
	#applyUltracodeRestoreCeiling(): void {
		const ceiling = this.#ultracodeRestoreCeiling;
		if (ceiling === undefined) return;
		this.#ultracodeRestoreCeiling = undefined;
		this.#thinkingLevelCeiling = ceiling ?? undefined;
	}

	/**
	 * Forget the pending restore, leaving the current level alone. The user's
	 * off-ramps call this right before applying the level they picked, so a
	 * session born armed gets its unpinned ceiling back first: an explicit
	 * `/effort max` must not be clamped to the pin's xhigh ceiling.
	 */
	forgetUltracodeRestore(): void {
		this.#applyUltracodeRestoreCeiling();
		this.#levelBeforeUltracode = undefined;
	}

	/** Timeout (ms) for per-turn auto-thinking classification before falling back. */
	static readonly #AUTO_THINKING_TIMEOUT_MS = 4000;

	/**
	 * Classify the current user turn and set the effective thinking level for it.
	 * `solutionSpace` is a delegator's open-endedness description (task-spawned turns
	 * only); when non-blank it is classified instead of `promptText`.
	 * Bounded by a timeout + abort; on failure it preserves the last classified
	 * level, or uses the provisional concrete level before the first resolution.
	 * Never throws into the turn, and never clears `#autoThinking`.
	 */
	async applyAutoThinkingLevel(promptText: string, generation: number, solutionSpace?: string): Promise<void> {
		const model = this.#model;
		if (!model?.reasoning) return;
		// Models with reasoning but no controllable effort surface (devin-agent
		// Cascade routes effort via sibling model ids, not a wire param) have
		// nothing to pick — skip classification rather than discard its result.
		if (getSupportedEfforts(model).length === 0) return;

		let resolved: Effort | undefined;
		if (cfgUltracode.get(this.#host.settings)) {
			// This turn carries the ultracode keyword and beginUltracodeTurn already
			// set the concrete level. If anything re-enabled auto since then, resolve
			// straight back to exactly xhigh instead of letting the difficulty
			// classifier walk the effort down mid-turn. A model with no xhigh rung
			// (or a hard ceiling below it) has nothing ultracode may pick: leave the
			// level alone rather than let the classifier or the ceiling clamp below
			// substitute a neighbor under the ultracode name.
			resolved = this.#ultracodePinEffort();
			if (resolved === undefined) return;
		} else if (this.#host.magicKeywordEnabled("ultrathink") && containsMagicKeyword(promptText, "ultrathink")) {
			// The user explicitly asked for maximum thinking; bypass the classifier
			// (and the `providers.autoThinkingMaxEffort` ceiling) and jump straight
			// to the highest supported level for this model.
			resolved = clampAutoThinkingEffort(model, Effort.Max);
		} else {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), ModelControls.#AUTO_THINKING_TIMEOUT_MS);
			const usageOwner = {
				sessionId: this.#host.sessionManager.getSessionId(),
				parentId: this.#host.sessionManager.getLeafId(),
			};
			try {
				resolved = await classifyDifficulty(
					{ request: promptText, solutionSpace },
					{
						settings: this.#host.settings,
						registry: this.#host.modelRegistry,
						model,
						sessionId: this.#host.sessionId(),
						signal: controller.signal,
						metadataResolver: provider => this.#host.agent.metadataForProvider(provider),
						onUsage: usage => {
							const entryId = this.#host.sessionManager.appendModelUsage(usage, usageOwner);
							if (entryId) usageOwner.parentId = entryId;
						},
						telemetry: this.#host.agent.telemetry,
					},
				);
			} catch (error) {
				logger.debug("auto-thinking: classification failed; using fallback level", {
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				clearTimeout(timer);
			}
		}

		// Drop the result if the turn was aborted/superseded while classifying.
		if (this.#host.promptGeneration() !== generation || !this.#autoThinking) return;

		const effort = clampThinkingLevelToCeiling(
			model,
			resolved ?? this.#autoResolvedLevel ?? resolveProvisionalAutoLevel(model),
			this.#thinkingLevelCeiling,
		);
		if (effort === undefined) return;
		const shouldPersistResolution = this.#thinkingLevel !== effort;
		this.#autoResolvedLevel = effort;
		this.#thinkingLevel = effort;
		this.#applyThinkingLevelToAgent(effort);
		if (shouldPersistResolution) {
			this.#host.sessionManager.appendThinkingLevelChange(effort, AUTO_THINKING);
		}
		this.#host.emit({
			type: "thinking_level_changed",
			thinkingLevel: effort,
			configured: AUTO_THINKING,
			resolved: effort,
		});
	}

	/**
	 * True when the currently selected model's family is set to a fast tier —
	 * `priority`, or `ultrafast` on the OpenAI family — the `/fast` on/off state
	 * for the active model. Returns false when no model is selected or the
	 * model exposes no service-tier family (e.g. Fireworks, which has its own
	 * Providers › Fireworks Tier toggle).
	 *
	 * For "is a fast tier actually applied to the next request?" use
	 * {@link isFastModeActive} instead.
	 */
	isFastModeEnabled(): boolean {
		const family = this.#model ? serviceTierFamily(this.#model) : undefined;
		const tier = family ? this.#serviceTierByFamily[family] : undefined;
		return tier === "priority" || tier === "ultrafast";
	}

	/** True when the active model's OpenAI family is set to `ultrafast` (`/fast ultra`). */
	isUltrafastModeEnabled(): boolean {
		const model = this.#model;
		return (
			model !== undefined &&
			serviceTierFamily(model) === "openai" &&
			this.#serviceTierByFamily.openai === "ultrafast"
		);
	}

	/**
	 * True when a fast tier is actually realized on the wire for the currently
	 * selected model: `priority` (OpenAI/Google `service_tier`, direct Anthropic
	 * fast mode, or Fireworks priority), or `ultrafast` where the model offers
	 * it. Returns false for tiers the active model can't realize and when no
	 * model is selected.
	 */
	isFastModeActive(): boolean {
		const model = this.#model;
		if (!model) return false;
		const tier = this.effectiveServiceTier(model);
		if (tier === "ultrafast") return shouldSendServiceTier(tier, model);
		if (!realizesPriorityServiceTier(tier, model)) return false;
		if (model.provider === "anthropic") {
			return !isAnthropicFastModeFallbackDisabled(this.#host.providerSessionState, model);
		}
		return true;
	}

	/**
	 * Effective wire service-tier for a request to `model`. Fireworks models take
	 * the Priority serving path only when the Providers › Fireworks Tier setting
	 * is `"priority"` (and never for `-fast` variants, whose Fast serving path is
	 * mutually exclusive with Priority). Every other model resolves the live
	 * per-family tier map down to the entry for its family.
	 */
	effectiveServiceTier(model: Model | undefined = this.#model): ServiceTier | undefined {
		if (model?.provider === "fireworks") {
			return cfgProvidersFireworksTier.get(this.#host.settings) === "priority" && !isFireworksFastModelId(model.id)
				? "priority"
				: undefined;
		}
		if (!model) return undefined;
		return resolveModelServiceTier(this.#serviceTierByFamily, model);
	}

	/** The live per-family tier map, or `null` when empty (for session persistence). */
	serviceTierEntry(): ServiceTierByFamily | null {
		return Object.keys(this.#serviceTierByFamily).length > 0 ? this.#serviceTierByFamily : null;
	}

	/** Set one family's tier (or clear it with `undefined`); persists the change. */
	setServiceTierFamily(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		if (this.#serviceTierByFamily[family] === tier) return;
		const next: ServiceTierByFamily = { ...this.#serviceTierByFamily };
		if (tier) next[family] = tier;
		else delete next[family];
		this.#applyServiceTierByFamily(next);
	}

	/** Replace the whole per-family tier map; persists + re-arms Anthropic fast mode. */
	#applyServiceTierByFamily(next: ServiceTierByFamily): void {
		// Re-arming Anthropic priority clears the per-session fast-mode auto-disable
		// so the next request actually carries `speed: "fast"` again.
		if (next.anthropic === "priority" && this.#serviceTierByFamily.anthropic !== "priority") {
			clearAnthropicFastModeFallback(this.#host.providerSessionState);
		}
		this.#serviceTierByFamily = next;
		this.#host.sessionManager.appendServiceTierChange(this.serviceTierEntry());
	}

	/**
	 * `/fast on|off` targets the family of the currently selected model: it sets
	 * (or clears) that family's `priority` tier. `off` also clears `ultrafast`.
	 * Returns `false` when the model has no service-tier family, or when it is an
	 * OpenAI-family model that cannot take `priority` (a Codex model whose
	 * discovered tier list omits it), so callers can report that fast mode is
	 * unavailable instead of claiming success.
	 */
	setFastMode(enabled: boolean): boolean {
		const model = this.#model;
		const family = model ? serviceTierFamily(model) : undefined;
		if (!model || !family) {
			this.#host.emitNotice(
				"info",
				"The current model has no service-tier control for /fast to toggle.",
				"priority",
			);
			return false;
		}
		if (!enabled) {
			const tier = this.#serviceTierByFamily[family];
			if (tier === "priority" || tier === "ultrafast") this.setServiceTierFamily(family, undefined);
			return true;
		}
		if (family === "openai" && !shouldSendServiceTier("priority", model)) {
			this.#host.emitNotice(
				"info",
				"The current model does not offer the priority (Fast) service tier.",
				"priority",
			);
			return false;
		}
		if (family === "anthropic" && this.#serviceTierByFamily.anthropic === "priority") {
			clearAnthropicFastModeFallback(this.#host.providerSessionState);
		}
		this.setServiceTierFamily(family, "priority");
		return true;
	}

	/**
	 * `/fast ultra` sets the OpenAI family to `ultrafast`. Enabling requires the
	 * active model to realize it (first-party OpenAI, or a Codex model whose
	 * discovery advertises the tier); otherwise the tier is left unchanged and
	 * `false` is returned. Disabling clears only an `ultrafast` selection.
	 */
	setUltrafastMode(enabled: boolean): boolean {
		const model = this.#model;
		if (!enabled) {
			if (this.#serviceTierByFamily.openai === "ultrafast") this.setServiceTierFamily("openai", undefined);
			return true;
		}
		if (!model || serviceTierFamily(model) !== "openai" || !shouldSendServiceTier("ultrafast", model)) {
			this.#host.emitNotice("info", "The current model does not offer the Ultrafast service tier.", "priority");
			return false;
		}
		this.setServiceTierFamily("openai", "ultrafast");
		return true;
	}

	toggleFastMode(): boolean {
		if (!this.setFastMode(!this.isFastModeEnabled())) return false;
		return this.isFastModeEnabled();
	}

	/**
	 * Get available thinking levels for current model.
	 */
	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		if (!this.#model) return [];
		return getSupportedEfforts(this.#model);
	}
}
