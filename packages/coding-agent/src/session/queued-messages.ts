import { type AgentMessage, ASIDE_MESSAGE_COMMIT } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import type { RestoredQueuedMessage } from "./agent-session-types";
import { type CustomMessage, readQueueChipText } from "./messages";

function queuedTextContent(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	for (const part of content) {
		if (part.type === "text") return part.text;
	}
	return undefined;
}

function queuedImageContent(message: AgentMessage): ImageContent[] | undefined {
	if (!("content" in message) || typeof message.content === "string") return undefined;
	const images: ImageContent[] = [];
	for (const part of message.content) {
		if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			images.push(part);
		}
	}
	return images.length > 0 ? images : undefined;
}

/** Whether a queued message should render in the queue UI. */
export function isDisplayableQueuedMessage(message: AgentMessage): boolean {
	return !(message.role === "custom" && message.display === false);
}

/** Whether a queued message is an advisor card. */
export function isAdvisorCard(message: AgentMessage): message is CustomMessage {
	return message.role === "custom" && message.customType === "advisor";
}

/** Whether a message is a terminal assistant answer containing text and no tools. */
export function isTerminalTextAssistantAnswer(message: AgentMessage | undefined): message is AssistantMessage {
	if (message?.role !== "assistant" || message.stopReason !== "stop") return false;
	let hasText = false;
	for (const part of message.content) {
		if (part.type === "toolCall") return false;
		if (part.type === "text") {
			if (part.text.trim().length > 0) hasText = true;
			continue;
		}
		if (
			part.type === "thinking" ||
			part.type === "redactedThinking" ||
			part.type === "fallback" ||
			part.type === "anthropicServerTool"
		)
			continue;
		return false;
	}
	return hasText;
}

/** Whether queued content was authored by the user and can be restored to the editor. */
export function isUserQueuedMessage(message: AgentMessage): boolean {
	if (message.role === "user") return true;
	return message.role === "custom" && message.attribution === "user" && message.display !== false;
}

/**
 * Hidden magic-keyword notices queued alongside a user prompt.
 *
 * Every `customType` pushed by `#createMagicKeywordNotices` MUST appear here.
 * A notice that is missing is invisible to both `isHiddenUserCompanion` and
 * `isUserQueuedMessage` (which requires `display !== false`), so dequeue and
 * clear walk straight past it: the user's prompt leaves the queue and the
 * hidden notice stays behind, uncounted, to be delivered ahead of some later
 * unrelated turn.
 */
export const MAGIC_KEYWORD_NOTICE_TYPES: Record<string, true> = {
	"ultracode-notice": true,
	"ultrathink-notice": true,
	"orchestrate-notice": true,
	"workflow-notice": true,
};

/** Hidden companion carrying vision descriptions for a text-only model. */
export const IMAGE_ATTACHMENT_DESCRIPTION_TYPE = "image-attachment-description";

/** Whether a hidden queued message is a companion of an adjacent user prompt. */
export function isHiddenUserCompanion(message: AgentMessage): boolean {
	return (
		message.role === "custom" &&
		message.attribution === "user" &&
		message.display === false &&
		(MAGIC_KEYWORD_NOTICE_TYPES[message.customType] === true ||
			message.customType === IMAGE_ATTACHMENT_DESCRIPTION_TYPE)
	);
}

/** Human-readable text shown for a queued-message chip. */
export function queueChipText(message: AgentMessage): string {
	if (message.role === "custom") {
		return readQueueChipText(message.details) ?? queuedTextContent(message) ?? "";
	}
	const text = queuedTextContent(message) ?? "";
	if (text) return text;
	return queuedImageContent(message) ? "[Image]" : "";
}

/**
 * Attach a side effect that runs exactly once, when the queued message is
 * committed into the live context (the agent loop's delivery point, before the
 * provider call that first includes the message).
 *
 * This is for state that must flip at TURN START rather than at enqueue: the
 * ultracode arm/disarm rides the queued user message so a steer/follow-up
 * queued during streaming cannot flip the effort pin under the in-flight turn,
 * and a message that is dequeued or handed back to the editor never fires it.
 */
export function attachQueuedMessageDeliveryEffect(message: AgentMessage, effect: () => void): void {
	Object.defineProperty(message, ASIDE_MESSAGE_COMMIT, { configurable: true, value: effect });
}

/** Converts a queued user message to editor-restorable content. */
export function toRestoredQueuedMessage(message: AgentMessage): RestoredQueuedMessage {
	return { text: queueChipText(message), images: queuedImageContent(message) };
}
