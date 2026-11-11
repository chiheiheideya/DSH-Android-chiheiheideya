import { CONTEXT_WINDOW_EXCEEDED_CODE, IMAGE_OFFLOAD_REQUIRED_CODE, LlmAdapter, LlmError, ProviderRequestId, ReasoningEffortId, RetryPolicySchema, ToolCallId, assertUsableApiKey, attributionHeaders, isContextWindowExceededError, isQuotaExceededError, offloadedImageText, requiredImageOffload, resolveRetryPolicy, textOnlyImageText } from "@deepseek-ai/dsh-llm";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson, isJsonValue } from "@deepseek-ai/dsh-util-values";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { longEdgeDimensions, requestImageDimensions } from "@deepseek-ai/dsh-attachment";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { readFileSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import { EventSourceParserStream, ParseError } from "eventsource-parser/stream";
/** Long-edge ceiling for one request image; a larger source is scaled down, never up. */
const IMAGE_MAX_DIMENSION = 4096;
/**
* Pixel budget a model declaring `imagePixelBudget: 'low'` selects. Both the
* value and the name come from the official adapter's published low-detail
* grid, so a profile imported from OWC keeps meaning the same request.
*/
const LOW_DETAIL_IMAGE_PIXEL_BUDGET = 262144;
/**
* The deterministic request version one model route asks the attachment
* provider for: the model's pixel budget when it declares one, the source
* dimensions otherwise, always capped at {@link IMAGE_MAX_DIMENSION} on the
* long edge, with the model's encoded-byte target.
* @param model - the route's declared facts for this model.
* @param source - intrinsic dimensions of the normalized attachment.
* @returns target dimensions and encoded-byte ceiling.
*/
function requestImageTarget(model, source) {
	const budget = model.imagePixelBudget;
	const projected = budget === void 0 ? {
		width: source.width,
		height: source.height
	} : requestImageDimensions(source.width, source.height, budget);
	return {
		...Math.max(projected.width, projected.height) > 4096 ? longEdgeDimensions(source.width, source.height, IMAGE_MAX_DIMENSION) : projected,
		maxBytes: model.imageMaxBytes ?? 2097152
	};
}
/** Visit every image block of one request, in conversation order. */
function visitImageBlocks(messages, visit) {
	for (const message of messages) for (const block of message.content) if (block.type === "image") visit(block);
}
/**
* The base64 data URL one request version is carried as.
* @param version - request bytes read from the attachment provider.
* @returns `data:` URL naming the encoded media type.
*/
function imageDataUrl(version) {
	return `data:${version.mediaType};base64,${Buffer.from(version.data).toString("base64")}`;
}
/**
* The text one offloaded occurrence contributes: the placeholder the durable
* offload decision left for it, naming the attachment and the read-only path a
* model tool can open instead of the bytes.
* @param block - an occurrence already marked offloaded.
* @returns deterministic placeholder text.
*/
function offloadedImageText$1(block) {
	return offloadedImageText(block.attachment);
}
/**
* Read one request version per retained attachment id.
* @param model - the route's declared facts for this model.
* @param messages - complete request inputs.
* @param attachments - mounted attachment provider; absence is a configuration error, not an omission.
* @param budget - route budgets the accumulated request must fit.
* @param signal - optional cancellation for provider reads.
* @returns request versions keyed by durable attachment id.
* @throws LlmError `INVALID_CONFIG` when no attachment provider is mounted, or
*   `IMAGE_OFFLOAD_REQUIRED` when the request exceeds the route budget.
*/
async function prepareRequestImages(model, messages, attachments, budget, signal) {
	const versions = /* @__PURE__ */ new Map();
	const references = [];
	visitImageBlocks(messages, (block) => {
		if (block.offloaded === true) return;
		references.push(block);
	});
	if (references.length === 0) return versions;
	if (attachments === void 0) throw new LlmError("llm-service-lite: this model declares image input, but no attachment provider is mounted", "INVALID_CONFIG");
	const bytesById = /* @__PURE__ */ new Map();
	for (const block of references) {
		const ref = block.attachment;
		let version = versions.get(ref.attachmentId);
		if (version === void 0) {
			version = await attachments.readImageRequest(ref, requestImageTarget(model, ref), signal);
			versions.set(ref.attachmentId, version);
		}
		bytesById.set(ref.attachmentId, version.bytes);
	}
	const overBudget = requiredImageOffload(messages, budget, (block) => bytesById.get(block.attachment.attachmentId));
	if (overBudget > 0) throw new LlmError(`llm-service-lite: provider image request exceeds the route budget; ${String(overBudget)} more oldest occurrence(s) must be offloaded.`, IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages: overBudget });
	return versions;
}
/**
* The visual tokens one request image of these dimensions costs under a
* declared accounting. Both spellings are published provider accountings rather
* than inventions: `area` charges a flat pixel grid (Claude bills one token per
* 750 pixels), and `tiles` charges a base plus one price per square tile the
* image covers, which is how the OpenAI vision documentation describes an
* image at full detail. A declaration the profile omitted prices nothing here —
* the token meter then keeps its own structural heuristic rather than a number
* this adapter guessed.
* @param accounting - the route's declared accounting.
* @param width - request-image width in pixels.
* @param height - request-image height in pixels.
* @returns provider visual tokens for one occurrence.
*/
function imageTokens(accounting, width, height) {
	if (accounting.kind === "area") return Math.ceil(width * height / accounting.per);
	return accounting.base + accounting.perTile * Math.ceil(width / accounting.tile) * Math.ceil(height / accounting.tile);
}
/**
* Price every surface image occurrence the way this route's request carries it.
*
* The token meter asks for one price per occurrence of the session surface, in
* model-visible order, and adds the returned text under its own text estimator.
* A retained occurrence is therefore priced at the very dimensions
* {@link requestImageTarget} will ask the attachment provider for — the one
* number that decides the endpoint's own charge — and contributes no text,
* because this adapter sends none beside the bytes. An offloaded occurrence
* contributes exactly the placeholder the request will carry, and a route
* without the image modality prices the deterministic substitution text the
* runtime puts in the image's place.
*
* @param model - the route's declared facts for this model.
* @returns synchronous per-occurrence pricing, or undefined when a route that
*   carries images declared no visual-token accounting.
*/
function imageRequestPricing(model) {
	if (!model.modalities.includes("image")) return { priceImages: (images) => images.map((block) => ({
		visualTokens: 0,
		text: textOnlyImageText(block.attachment)
	})) };
	const accounting = model.imageTokens;
	if (accounting === void 0) return void 0;
	return { priceImages: (images) => images.map((block) => {
		if (block.offloaded === true) return {
			visualTokens: 0,
			text: offloadedImageText$1(block)
		};
		const target = requestImageTarget(model, block.attachment);
		return {
			visualTokens: imageTokens(accounting, target.width, target.height),
			text: ""
		};
	}) };
}
//#endregion
//#region lib/types/official-catalog.js
/**
* Conversion of an official model-configuration file into this adapter's own
* profile vocabulary.
*
* An official file — the catalog an official deployment ships as
* `providers/data/<provider>.json` — groups its entries by API and keys each
* model by `<type>:<id>`; this adapter serves one protocol per route and names
* every model by its bare id. The conversion therefore materializes a route
* profile: the API becomes `interfaceType`, `baseUrl` becomes `baseURL`, each
* chat entry becomes a model with its capacities, input modalities, and
* thinking levels, and a model's sampling parameters become its request
* defaults. A field this adapter has no counterpart for is reported one by
* one instead of guessed, so a converted profile states exactly what the
* official file stated and nothing more.
*
* @module dsh-llm-service-lite/official-catalog
*/
/** Official API names this adapter serves, and the protocol each becomes. */
const OFFICIAL_APIS = {
	"openai-completions": "openai-chat-completions",
	"openai-responses": "openai-responses",
	"anthropic-messages": "anthropic-messages"
};
/** Official model types this adapter serves; every other type is reported. */
const OFFICIAL_CHAT_TYPE = "chat";
/** Effort levels an official thinking map may name, in this adapter's order. */
const LEVELS_FROM_OFFICIAL = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Sampling parameters that become request defaults, and the field each feeds. */
const SAMPLING_DEFAULTS = {
	temperature: "temperature",
	top_p: "topP",
	top_k: "topK"
};
/** Official compat flags that state a mid-history capability this adapter declares. */
const COMPAT_CAPABILITIES = {
	supportsMidConvoSystemMessages: "systemPromptUpdate",
	supportsMidConvoToolAdditions: "toolUpdate"
};
/** Entry fields the conversion reads; every other field is reported as not carried. */
const KNOWN_ENTRY_FIELDS = /* @__PURE__ */ new Set([
	"id",
	"name",
	"api",
	"provider",
	"baseUrl",
	"type",
	"input",
	"reasoning",
	"thinkingLevelMap",
	"contextWindow",
	"maxTokens",
	"headers",
	"samplingParams",
	"compat"
]);
/** Whether a value is a plain object, which is what every official node must be. */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Read one string field of an official entry, or undefined when it states none. */
function officialString(entry, field) {
	const value = entry[field];
	return typeof value === "string" ? value : void 0;
}
/** Read one finite number field of an official entry, or undefined when it states none. */
function officialNumber(entry, field) {
	const value = entry[field];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/**
* The input modalities one official entry declares, with every value this
* adapter does not carry reported by name.
* @param entry - official entry.
* @param report - diagnostic sink.
* @returns declared modalities, empty when the entry states none this adapter carries.
*/
function officialModalities(entry, report) {
	const declared = entry["input"];
	if (declared === void 0) return [];
	if (!Array.isArray(declared)) return [];
	const modalities = [];
	for (const value of declared) {
		if (value === "text" || value === "image") {
			if (!modalities.includes(value)) modalities.push(value);
			continue;
		}
		report(`input modality "${String(value)}" is not carried`);
	}
	return modalities;
}
/**
* The reasoning selector one official entry declares: the levels its thinking
* map spells, and whether its endpoint can turn thinking off.
* @param entry - official entry.
* @returns declared effort levels and accepted thinking modes.
*/
function officialThinking(entry) {
	if (entry["reasoning"] !== true) return {
		effort: [],
		thinking: []
	};
	const map = entry["thinkingLevelMap"];
	const levels = isPlainObject(map) ? map : {};
	return {
		effort: LEVELS_FROM_OFFICIAL.filter((level) => typeof levels[level] === "string"),
		thinking: levels["off"] === null ? ["enabled"] : ["enabled", "disabled"]
	};
}
/**
* The request defaults one official entry declares, from the sampling
* parameters the two OpenAI-compatible protocols merge into their body.
* @param entry - official entry.
* @param report - diagnostic sink.
* @returns declared defaults, absent fields omitted.
*/
function officialDefaults(entry, report) {
	const sampling = entry["samplingParams"];
	if (sampling === void 0) return void 0;
	if (!isPlainObject(sampling)) return void 0;
	const defaults = {};
	for (const [key, value] of Object.entries(sampling)) {
		const field = SAMPLING_DEFAULTS[key];
		if (field === void 0 || typeof value !== "number" || !Number.isFinite(value)) {
			report(`sampling parameter "${key}" is not carried; only temperature, top_p, and top_k map onto a model's defaults`);
			continue;
		}
		defaults[field] = value;
	}
	return Object.keys(defaults).length === 0 ? void 0 : defaults;
}
/**
* One official chat entry as this adapter's model profile.
* @param entry - official entry.
* @param id - model id, from the entry or its catalog key.
* @param interfaceType - protocol the converted route speaks.
* @param report - diagnostic sink.
* @returns the model profile the entry converts into.
* @throws Error when the entry names no usable model id.
*/
function officialModel(entry, id, interfaceType, report) {
	if (id.length === 0) throw new Error("an official chat entry names no model id");
	const anthropic = interfaceType === "anthropic-messages";
	const { effort, thinking } = officialThinking(entry);
	const modalities = officialModalities(entry, report);
	const defaults = anthropic ? void 0 : officialDefaults(entry, report);
	if (anthropic && entry["samplingParams"] !== void 0) report("sampling parameters are not carried on anthropic-messages; that protocol ignores them");
	const compat = entry["compat"];
	let systemPromptUpdate;
	let toolUpdate;
	if (isPlainObject(compat)) for (const [flag, value] of Object.entries(compat)) {
		const capability = COMPAT_CAPABILITIES[flag];
		if (capability === void 0) {
			if (value === false || value === void 0) continue;
			report(`compat flag "${flag}" is not carried; declare the capability on the profile`);
			continue;
		}
		if (value !== true) continue;
		if (!anthropic) {
			report(`compat flag "${flag}" is not carried; declare the capability on the profile`);
			continue;
		}
		if (capability === "systemPromptUpdate") systemPromptUpdate = "in-history";
		if (capability === "toolUpdate") toolUpdate = "addition-only";
	}
	const name = officialString(entry, "name");
	const contextWindow = officialNumber(entry, "contextWindow");
	const maxTokens = officialNumber(entry, "maxTokens");
	const capabilities = {
		...modalities.length === 0 ? {} : { modalities },
		...effort.length === 0 ? {} : { effort },
		...thinking.length === 0 ? {} : { thinking },
		...systemPromptUpdate === void 0 ? {} : { systemPromptUpdate },
		...toolUpdate === void 0 ? {} : { toolUpdate }
	};
	return {
		id,
		...name === void 0 ? {} : { name },
		...contextWindow === void 0 ? {} : { contextWindow },
		...maxTokens === void 0 ? {} : { maxTokens },
		...Object.keys(capabilities).length === 0 ? {} : { capabilities },
		...defaults === void 0 ? {} : { defaults }
	};
}
/**
* Convert one official provider file into this adapter's own profile facts.
*
* The conversion is total for the fields it understands and explicit about
* the rest: it returns the profile plus one diagnostic line per official
* field it could not carry, and it throws only when the file describes
* something no single route can be — an unknown protocol, entries that
* disagree about the protocol or the endpoint, or no chat model at all.
*
* @param source - parsed official file content, one provider's catalog.
* @param route - route name the profile will serve under, for diagnostics.
* @returns the converted profile facts and the conversion's diagnostics.
* @throws Error when the file cannot become one route profile.
*/
function convertOfficialProvider(source, route) {
	const prefix = `llm-service-lite: provider "${route}" catalog`;
	if (!isPlainObject(source)) throw new Error(`${prefix} is not an object; an official provider file is one API-keyed map`);
	const counted = /* @__PURE__ */ new Map();
	const report = (message) => {
		counted.set(message, (counted.get(message) ?? 0) + 1);
	};
	const models = [];
	const apis = /* @__PURE__ */ new Set();
	const baseURLs = /* @__PURE__ */ new Set();
	const headerSets = /* @__PURE__ */ new Set();
	for (const [api, group] of Object.entries(source)) {
		if (!isPlainObject(group)) throw new Error(`${prefix} group "${api}" is not an object`);
		for (const [key, raw] of Object.entries(group)) {
			if (!isPlainObject(raw)) throw new Error(`${prefix} entry "${key}" is not an object`);
			const entry = raw;
			const type = officialString(entry, "type") ?? key.split(":", 1)[0];
			if (type !== OFFICIAL_CHAT_TYPE) {
				report(`entry "${key}" is a ${type} model, which this adapter does not serve`);
				continue;
			}
			const officialApi = officialString(entry, "api") ?? api;
			if (OFFICIAL_APIS[officialApi] === void 0) throw new Error(`${prefix} names api "${officialApi}", which this adapter does not serve; it serves ${Object.keys(OFFICIAL_APIS).join(", ")}`);
			apis.add(officialApi);
			const baseUrl = officialString(entry, "baseUrl");
			if (baseUrl !== void 0) baseURLs.add(baseUrl);
			const headers = entry["headers"];
			if (isPlainObject(headers)) headerSets.add(JSON.stringify(headers));
			for (const field of Object.keys(entry)) if (!KNOWN_ENTRY_FIELDS.has(field)) report(`field "${field}" is not carried`);
			const id = officialString(entry, "id") ?? key.slice(key.indexOf(":") + 1);
			models.push(officialModel(entry, id, OFFICIAL_APIS[officialApi], report));
		}
	}
	if (apis.size > 1) throw new Error(`${prefix} mixes apis ${[...apis].sort().join(" and ")}; one route serves one protocol, so convert it into one profile per protocol`);
	const [onlyApi] = [...apis];
	if (onlyApi === void 0 || models.length === 0) throw new Error(`${prefix} carries no chat model this adapter serves`);
	if (baseURLs.size > 1) throw new Error(`${prefix} names ${baseURLs.size} endpoints across its models; one route serves one baseURL`);
	if (headerSets.size > 1) report("models declare different headers, which one route cannot carry");
	const headers = headerSets.size === 1 ? JSON.parse([...headerSets][0]) : void 0;
	return {
		profile: {
			interfaceType: OFFICIAL_APIS[onlyApi],
			...baseURLs.size === 0 ? {} : { baseURL: [...baseURLs][0] },
			...headers === void 0 ? {} : { headers },
			models
		},
		diagnostics: [...counted].map(([message, count]) => count === 1 ? `${prefix} ${message}` : `${prefix} ${message} (${count} models)`)
	};
}
/**
* The researched family table. Order matters: the first rule whose pattern
* matches the lowercased model id wins, so keep specific rules above the
* general rule of the same family.
*/
const MODEL_DEFAULT_RULES = [
	{
		family: "claude-5-reasoning",
		match: [/^claude-(fable-5|sonnet-5)/],
		contextWindow: 1e6,
		maxTokens: 128e3,
		modalities: ["text", "image"],
		effort: [
			"low",
			"medium",
			"high",
			"xhigh",
			"max"
		],
		effortDefault: "high",
		anthropicMaxTokens: 131072,
		note: "Anthropic models overview: Fable 5.1 / Sonnet 5 adaptive thinking with effort high, max output 128K, read 2026-10-10"
	},
	{
		family: "claude-opus-5",
		match: [/^claude-opus-5/],
		contextWindow: 1e6,
		maxTokens: 128e3,
		modalities: ["text", "image"],
		effort: [
			"low",
			"medium",
			"high",
			"xhigh",
			"max"
		],
		effortDefault: "medium",
		anthropicMaxTokens: 131072,
		note: "Anthropic models overview: Opus 5.5 adaptive thinking with effort medium, max output 128K, read 2026-10-10"
	},
	{
		family: "claude-5",
		match: [/^claude-(opus-5|sonnet-5|haiku-5|fable-5)/],
		contextWindow: 1e6,
		maxTokens: 128e3,
		modalities: ["text", "image"],
		effort: [
			"low",
			"medium",
			"high",
			"xhigh",
			"max"
		],
		anthropicMaxTokens: 131072,
		note: "Official catalog (models.dev anthropic: output 128000, effort low..max), read 2026-10-10"
	},
	{
		family: "claude-128k",
		match: [/^claude-(opus-4-[678]|sonnet-4-6)/],
		contextWindow: 1e6,
		maxTokens: 128e3,
		modalities: ["text", "image"],
		effort: [
			"low",
			"medium",
			"high",
			"xhigh",
			"max"
		],
		anthropicMaxTokens: 131072,
		note: "Official catalog (pi-ai 1.0.2: max output 128000), no vendor doc read, 2026-10-10"
	},
	{
		family: "claude-64k",
		match: [/^claude-(opus-4-5|sonnet-4-5|haiku-4-5)/],
		contextWindow: 2e5,
		maxTokens: 64e3,
		modalities: ["text", "image"],
		anthropicMaxTokens: 65536,
		note: "Anthropic models overview (Haiku 4.5 max output 64K) + official catalog, read 2026-10-10"
	},
	{
		family: "claude-other",
		match: [/^claude-/],
		modalities: ["text", "image"],
		anthropicMaxTokens: 65536,
		note: "Conservative Claude default, pi-ai catalog 1.0.2, read 2026-10-10"
	},
	{
		family: "kimi-coding-k3",
		match: [/^k3(-256k)?$/],
		contextWindow: 1048576,
		maxTokens: 131072,
		modalities: ["text", "image"],
		effort: [
			"low",
			"high",
			"max"
		],
		effortDefault: "max",
		anthropicMaxTokens: 131072,
		note: "Moonshot K3 docs (default effort max) + models.dev kimi-code-plan-cn output 131072, read 2026-10-10"
	},
	{
		family: "kimi-coding",
		match: [/^kimi-for-coding/],
		contextWindow: 1048576,
		maxTokens: 32768,
		modalities: ["text", "image"],
		effort: [
			"low",
			"high",
			"max"
		],
		effortDefault: "max",
		anthropicMaxTokens: 32768,
		note: "Kimi Code docs: `kimi-for-coding` now serves K2.8 Preview with effort low/high/max default max over 1M context; official catalog records output 32768, read 2026-10-10"
	},
	{
		family: "minimax-m3.1",
		match: [/^minimax-m3\.1/],
		contextWindow: 1e6,
		maxTokens: 512e3,
		modalities: ["text", "image"],
		effort: [
			"low",
			"medium",
			"high",
			"xhigh",
			"max"
		],
		effortDefault: "max",
		anthropicMaxTokens: 524288,
		note: "MiniMax Anthropic API docs: M3.1-Flash-Preview output_config.effort low..max, default max, read 2026-10-10"
	},
	{
		family: "minimax-m3",
		match: [/^minimax-m3/],
		contextWindow: 1e6,
		maxTokens: 512e3,
		modalities: ["text", "image"],
		thinking: ["adaptive", "disabled"],
		anthropicMaxTokens: 524288,
		note: "MiniMax docs: M3 thinking off by default, adaptive enables it; models.dev output 512000, read 2026-10-10"
	},
	{
		family: "minimax-m2",
		match: [/^minimax-m2/],
		contextWindow: 204800,
		maxTokens: 131072,
		modalities: ["text"],
		anthropicMaxTokens: 131072,
		note: "MiniMax Anthropic API docs + models.dev: output 131072, read 2026-10-10"
	},
	{
		family: "deepseek-v4-vision",
		match: [/^deepseek-(v4-flash|v4\.1|flash)/],
		contextWindow: 1e6,
		maxTokens: 393216,
		modalities: ["text", "image"],
		reasoningContent: true,
		replayReasoning: true,
		replayRequired: true,
		thinkingStyle: "thinking",
		effort: [
			"low",
			"high",
			"max"
		],
		effortDefault: "high",
		note: "DeepSeek thinking-mode docs: effort low/high/max, default high (minimal→low, medium/xhigh→high, ultra→max); reasoning_content must be replayed, read 2026-10-10"
	},
	{
		family: "deepseek-v4",
		match: [/^deepseek-v4/],
		contextWindow: 1e6,
		maxTokens: 393216,
		modalities: ["text"],
		reasoningContent: true,
		replayReasoning: true,
		replayRequired: true,
		thinkingStyle: "thinking",
		effort: [
			"low",
			"high",
			"max"
		],
		effortDefault: "high",
		note: "DeepSeek thinking-mode docs: effort low/high/max, default high; thinking defaults enabled, read 2026-10-10"
	},
	{
		family: "deepseek",
		match: [/^deepseek-/],
		reasoningContent: true,
		thinkingStyle: "thinking",
		note: "DeepSeek family default, read 2026-10-10"
	},
	{
		family: "kimi-k3",
		match: [/^kimi-k3/],
		contextWindow: 1048576,
		maxTokens: 1048576,
		modalities: ["text", "image"],
		reasoningContent: true,
		replayReasoning: true,
		replayRequired: true,
		thinkingStyle: "effort_only",
		effort: [
			"low",
			"high",
			"max"
		],
		effortDefault: "max",
		note: "Moonshot K3 docs (top-level reasoning_effort, default max; assistant message must be replayed intact), read 2026-10-10"
	},
	{
		family: "kimi-k2.7",
		match: [/^kimi-k2\.7/],
		contextWindow: 262144,
		maxTokens: 262144,
		modalities: ["text", "image"],
		reasoningContent: true,
		replayReasoning: true,
		replayRequired: true,
		thinking: ["enabled"],
		note: "Moonshot docs: kimi-k2.7-code cannot disable thinking, preserved thinking always on, read 2026-10-10"
	},
	{
		family: "kimi-k2.6",
		match: [/^kimi-k2\.6/],
		contextWindow: 262144,
		maxTokens: 262144,
		modalities: ["text", "image"],
		reasoningContent: true,
		thinking: ["enabled", "disabled"],
		note: "Moonshot docs: kimi-k2.6 toggle + optional thinking.keep, read 2026-10-10"
	},
	{
		family: "kimi",
		match: [/^kimi-/, /^moonshot/],
		modalities: ["text", "image"],
		reasoningContent: true,
		note: "Moonshot family default, read 2026-10-10"
	},
	{
		family: "glm-5.3-vision",
		match: [/^glm-5\.3-flash/],
		contextWindow: 1e6,
		maxTokens: 131072,
		modalities: ["text", "image"],
		reasoningContent: true,
		thinkingStyle: "thinking",
		thinking: ["enabled"],
		effort: [
			"low",
			"high",
			"max"
		],
		effortDefault: "max",
		anthropicMaxTokens: 131072,
		note: "Zhipu docs: GLM-5.3-Flash forces thinking (only enabled), effort low/high/max default max, 1M context / 128K output, image+video input, read 2026-10-10"
	},
	{
		family: "glm-vision",
		match: [/^glm-5v/, /^glm-4\.6v/],
		contextWindow: 2e5,
		maxTokens: 131072,
		modalities: ["text", "image"],
		reasoningContent: true,
		thinkingStyle: "thinking",
		note: "Zhipu docs: glm-5v-turbo / glm-4.6v accept images and choose thinking dynamically, read 2026-10-10"
	},
	{
		family: "glm-5.3",
		match: [/^glm-5\.3/],
		contextWindow: 1e6,
		maxTokens: 131072,
		reasoningContent: true,
		thinkingStyle: "thinking",
		thinking: ["enabled"],
		effort: [
			"low",
			"high",
			"max"
		],
		effortDefault: "max",
		anthropicMaxTokens: 131072,
		note: "Zhipu docs: glm-5.3 cannot disable thinking, effort low/high/max default max, 1M context / 128K output, read 2026-10-10"
	},
	{
		family: "glm-5.2",
		match: [/^glm-5\.2/],
		contextWindow: 1e6,
		maxTokens: 131072,
		reasoningContent: true,
		thinkingStyle: "thinking",
		effort: ["high", "max"],
		effortDefault: "max",
		note: "Zhipu docs: glm-5.2 effort high/max with max as the default, read 2026-10-10"
	},
	{
		family: "glm",
		match: [/^glm-/],
		reasoningContent: true,
		thinkingStyle: "thinking",
		note: "Zhipu family default: thinking {type, clear_thinking}, read 2026-10-10"
	},
	{
		family: "qwen3.8-max",
		match: [/^qwen3\.8-max/],
		contextWindow: 1e6,
		maxTokens: 131072,
		modalities: ["text", "image"],
		reasoningContent: true,
		replayReasoning: true,
		replayRequired: true,
		thinkingStyle: "enable_thinking",
		thinking: ["enabled", "disabled"],
		effort: [
			"low",
			"medium",
			"xhigh"
		],
		effortDefault: "xhigh",
		note: "Alibaba Model Studio: qwen3.8-max effort low/medium/xhigh, default xhigh (cannot combine with thinking_budget); preserve_thinking defaults true, read 2026-10-10"
	},
	{
		family: "qwen3.8",
		match: [/^qwen3\.8/],
		contextWindow: 1e6,
		maxTokens: 131072,
		modalities: ["text", "image"],
		reasoningContent: true,
		thinkingStyle: "enable_thinking",
		thinking: ["enabled", "disabled"],
		effort: [
			"low",
			"medium",
			"xhigh"
		],
		effortDefault: "xhigh",
		note: "Qwen AI platform API reference: Qwen3.8 series effort low/medium/xhigh, default xhigh, read 2026-10-10"
	},
	{
		family: "qwen3.7-max",
		match: [/^qwen3\.7-max/],
		contextWindow: 1e6,
		maxTokens: 131072,
		modalities: ["text"],
		reasoningContent: true,
		thinkingStyle: "enable_thinking",
		thinking: ["enabled", "disabled"],
		note: "Alibaba Model Studio: qwen3.7-max text-only, read 2026-10-10"
	},
	{
		family: "qwen3.5+",
		match: [/^qwen3\.[5-8]/],
		contextWindow: 1e6,
		maxTokens: 65536,
		modalities: ["text", "image"],
		reasoningContent: true,
		thinkingStyle: "enable_thinking",
		thinking: ["enabled", "disabled"],
		note: "Alibaba Model Studio deep-thinking docs (enable_thinking, default on for 3.5+), read 2026-10-10"
	},
	{
		family: "qwen",
		match: [
			/^qwen/,
			/^qwq/,
			/^qvq/
		],
		reasoningContent: true,
		thinkingStyle: "enable_thinking",
		note: "Qwen family default (Qwen AI platform ignores reasoning_effort), read 2026-10-10"
	},
	{
		family: "doubao-seed-2.0",
		match: [/^doubao-seed-2-0/, /^doubao-seed-character/],
		contextWindow: 256e3,
		maxTokens: 128e3,
		modalities: ["text", "image"],
		reasoningContent: true,
		thinkingStyle: "thinking",
		effort: [
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max"
		],
		effortDefault: "medium",
		note: "Volcengine Ark deep-thinking docs: seed-2.0/character default effort medium (minimal disables thinking), read 2026-10-10"
	},
	{
		family: "doubao-seed",
		match: [
			/^doubao-/,
			/^seed-/,
			/\/seed-/
		],
		contextWindow: 256e3,
		maxTokens: 256e3,
		modalities: ["text", "image"],
		reasoningContent: true,
		thinkingStyle: "thinking",
		effort: [
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max"
		],
		effortDefault: "high",
		note: "Volcengine Ark deep-thinking docs (thinking.type enabled/disabled/auto; seed-2.1/evolving default effort high), read 2026-10-10"
	},
	{
		family: "hunyuan-hy4",
		match: [/^hy4/, /^hunyuan-4/],
		contextWindow: 1024e3,
		maxTokens: 64e3,
		reasoningContent: true,
		thinkingStyle: "thinking",
		effort: [
			"low",
			"medium",
			"high"
		],
		effortDefault: "high",
		note: "Tencent Hunyuan docs: hy4-preview/hy3 default reasoning_effort high; low maps to high when tools are present, read 2026-10-10"
	},
	{
		family: "hunyuan",
		match: [/^hy\d/, /^hunyuan/],
		contextWindow: 256e3,
		maxTokens: 128e3,
		reasoningContent: true,
		thinkingStyle: "thinking",
		effort: [
			"low",
			"medium",
			"high"
		],
		effortDefault: "high",
		note: "Tencent Hunyuan deep-thinking docs: thinking {type} plus reasoning_effort, default high, read 2026-10-10"
	},
	{
		family: "ernie-5.0",
		match: [/^ernie-5\.0/],
		contextWindow: 131072,
		maxTokens: 65536,
		modalities: ["text", "image"],
		reasoningContent: true,
		thinkingStyle: "enable_thinking",
		thinking: ["enabled", "disabled"],
		note: "Baidu Qianfan model list (ERNIE 5.0 listed under 视觉理解) + deep-thinking docs, read 2026-10-10"
	},
	{
		family: "ernie-5.1",
		match: [/^ernie-5\.1/],
		contextWindow: 131072,
		maxTokens: 65536,
		modalities: ["text"],
		reasoningContent: true,
		thinkingStyle: "enable_thinking",
		thinking: ["enabled", "disabled"],
		note: "Baidu Qianfan model list (text only; thinking_budget supported) + enable_thinking family spelling, read 2026-10-10"
	},
	{
		family: "ernie-x1",
		match: [/^ernie-x1/],
		contextWindow: 65536,
		maxTokens: 65536,
		reasoningContent: true,
		thinking: ["enabled"],
		note: "Baidu Qianfan deep-thinking docs: ERNIE X1 is thinking-only, read 2026-10-10"
	},
	{
		family: "ernie-vl",
		match: [/^ernie-.*-vl/],
		contextWindow: 131072,
		maxTokens: 16384,
		modalities: ["text", "image"],
		note: "Baidu Qianfan vision model list (ernie-4.5-turbo-vl, ernie-4.5-vl-28b-a3b), read 2026-10-10"
	},
	{
		family: "step-5",
		match: [/^step-5/],
		contextWindow: 1e6,
		maxTokens: 65536,
		modalities: ["text", "image"],
		effort: [
			"low",
			"medium",
			"high"
		],
		effortDefault: "medium",
		note: "StepFun docs: step-5-preview carries a 1M context; reasoning_effort low/medium/high, medium recommended, read 2026-10-10"
	},
	{
		family: "step",
		match: [/^step-\d/],
		contextWindow: 256e3,
		maxTokens: 256e3,
		modalities: ["text", "image"],
		effort: [
			"low",
			"medium",
			"high"
		],
		effortDefault: "medium",
		note: "StepFun reasoning docs: reasoning_effort low/medium/high with medium the recommended default; reasoning arrives in a `reasoning` field, read 2026-10-10"
	},
	{
		family: "mimo",
		match: [/^mimo-/],
		contextWindow: 1048576,
		maxTokens: 131072,
		modalities: ["text", "image"],
		reasoningContent: true,
		replayReasoning: true,
		replayRequired: true,
		thinkingStyle: "thinking",
		thinking: ["enabled", "disabled"],
		note: "Xiaomi MiMo docs (thinking default on; reasoning_content must be replayed with tool calls, else 400), read 2026-10-10"
	},
	{
		family: "sensenova",
		match: [/^sensenova-/],
		contextWindow: 262144,
		maxTokens: 65536,
		modalities: ["text", "image"],
		effort: [
			"low",
			"medium",
			"high",
			"max"
		],
		effortDefault: "high",
		note: "SenseNova platform docs: thinking on by default, reasoning_effort low/medium/high/max default high, `reasoning` field not replayed, read 2026-10-10"
	},
	{
		family: "longcat",
		match: [/^longcat/],
		contextWindow: 1e6,
		maxTokens: 131072,
		modalities: ["text"],
		thinkingStyle: "thinking",
		thinking: ["enabled", "disabled"],
		anthropicMaxTokens: 131072,
		note: "LongCat API docs: thinking {type: enabled|disabled}; LongCat-2.5-Preview/2.0 max output 131072 over 1M context on both OpenAI and Anthropic endpoints, read 2026-10-10"
	},
	{
		family: "openai-reasoning-nodefault",
		match: [/^gpt-5\.1/],
		contextWindow: 4e5,
		maxTokens: 128e3,
		modalities: ["text", "image"],
		replayReasoning: false,
		effort: [
			"low",
			"medium",
			"high"
		],
		note: "OpenAI docs: gpt-5.1 defaults reasoning_effort to none, read 2026-10-10"
	},
	{
		family: "openai-reasoning",
		match: [
			/^gpt-5/,
			/^gpt-6/,
			/^o[1-4]/
		],
		contextWindow: 4e5,
		maxTokens: 128e3,
		modalities: ["text", "image"],
		replayReasoning: false,
		effort: [
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max"
		],
		effortDefault: "medium",
		note: "OpenAI reasoning docs: reasoning_effort defaults to medium (gpt-5.5/5.6/6.x), encrypted replay only, read 2026-10-10"
	}
];
/**
* Every spelling of one model id a rule may be written against.
*
* Providers name their models in more than one shape: the vendor's own id
* (`claude-haiku-5.5`), a gateway's namespaced form
* (`anthropic/claude-haiku-5.5`), and the router form that marks a normalized
* id with a leading `~` (`~anthropic/claude-opus-latest`). A rule is written
* once against the model's own name, and every spelling is offered to it, so a
* namespaced id resolves to the same family as the bare one.
* @param modelId - the model id as the profile spells it.
* @returns the lowercased id and every suffix after a leading `vendor/` or `~`.
*/
function idSpellingsOf(modelId) {
	const id = modelId.toLowerCase();
	const spellings = [id];
	let rest = id.startsWith("~") ? id.slice(1) : id;
	spellings.push(rest);
	while (rest.includes("/")) {
		rest = rest.slice(rest.indexOf("/") + 1);
		spellings.push(rest);
	}
	return spellings;
}
/**
* The rule that speaks for one model, or nothing when no family matches.
* @param modelId - the model id as the profile spells it, in any provider naming.
* @returns the first matching rule in table order.
*/
function modelDefaultRuleOf(modelId) {
	const spellings = idSpellingsOf(modelId);
	return MODEL_DEFAULT_RULES.find((rule) => rule.match.some((pattern) => spellings.some((id) => pattern.test(id))));
}
/**
* One model's researched defaults, spelled as a profile would state them.
*
* This is what a configuration surface writes into a document when a user asks
* to see the defaults rather than inherit them: every field is the same
* vocabulary the profile schema accepts, so the reply can be written through
* unchanged and edited afterwards like anything else the user typed.
* @param modelId - the model id as the profile spells it.
* @param interfaceType - the route's protocol, which decides whether a cap is stated.
* @returns the declarations, or nothing when no family speaks for this id.
*/
function declaredDefaultsOf(modelId, interfaceType) {
	const rule = modelDefaultRuleOf(modelId);
	if (rule === void 0) return void 0;
	const capabilities = {};
	if (rule.modalities !== void 0) capabilities["modalities"] = [...rule.modalities];
	if (rule.effort !== void 0) capabilities["effort"] = [...rule.effort];
	if (rule.thinking !== void 0) capabilities["thinking"] = [...rule.thinking];
	if (rule.thinkingStyle !== void 0) capabilities["thinkingStyle"] = rule.thinkingStyle;
	if (rule.reasoningContent !== void 0) capabilities["reasoningContent"] = rule.reasoningContent;
	if (rule.replayReasoning !== void 0) capabilities["replayReasoning"] = rule.replayReasoning;
	const defaults = interfaceType === "anthropic-messages" && rule.anthropicMaxTokens !== void 0 ? { maxTokens: rule.anthropicMaxTokens } : {};
	return {
		id: modelId,
		...rule.contextWindow === void 0 ? {} : { contextWindow: rule.contextWindow },
		...rule.maxTokens === void 0 ? {} : { maxTokens: rule.maxTokens },
		capabilities,
		defaults,
		note: rule.note
	};
}
/**
* The output cap an Anthropic Messages request declares for one model, absent
* a profile or caller override.
* @param modelId - the model id as the profile spells it.
* @returns the family's cap, else {@link ANTHROPIC_FALLBACK_MAX_TOKENS}.
*/
function anthropicMaxTokensOf(modelId) {
	return modelDefaultRuleOf(modelId)?.anthropicMaxTokens ?? 65536;
}
//#endregion
//#region lib/types/config.js
/**
* Configuration schema and provider-profile vocabulary for the OWC-style
* adapter.
*
* The shape follows OpenWebCode's model-provider layer rather than pi-ai's
* catalog: a profile is a self-contained endpoint declaration — protocol,
* endpoint, credential, and the models it serves — and the `providers` dict
* key is the route a request selects. Nothing here assumes an installed
* catalog knows the provider, so a gateway reaches the same code path as a
* first-party endpoint.
*
* One deliberate departure: a credential may be named as a harness reference
* (`apiKeyEnv`) instead of being written into the configuration, which is how
* a deployment keeps secrets out of a file that may be committed. An inline
* `apiKey` remains available for a profile imported verbatim from OWC.
*
* @module dsh-llm-service-lite/config
*/
/**
* Wire protocols a provider profile may name, spelled the way OWC spells
* them. `openai-chat-completions` is the broadest by far: DeepSeek, Qwen,
* GLM, Kimi, and every self-hosted vLLM or SGLang server speak it, which is
* why it is the default a configuration surface should offer first.
*/
const INTERFACE_TYPES = [
	"openai-chat-completions",
	"anthropic-messages",
	"openai-responses"
];
/**
* Reasoning-effort levels a model may offer, ordered least to most expensive.
* The level id is also its wire spelling for `openai-chat-completions`: OWC
* sends exactly the level the user picked, so a gateway with its own
* vocabulary declares that vocabulary as its levels.
*/
const EFFORT_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra"
];
/**
* Thinking modes a model may accept. `disabled` is a capability that means
* the endpoint can be told to stop thinking; a model offering only that mode
* publishes no selectable reasoning levels.
*/
const THINKING_MODES = [
	"adaptive",
	"enabled",
	"disabled"
];
/**
* How a chat-completions endpoint spells the thinking switch, mirroring OWC's
* `thinkingStyle`: `thinking` and `fixed` send `thinking: { type }`,
* `enable_thinking` sends a top-level boolean, and `effort_only` — like an
* unset style — sends only the effort level. The explicit spelling of "no
* switch" exists so an OWC-format document carries over without editing: it
* declares the same behaviour the omitted style already gives.
*/
const THINKING_STYLES = [
	"thinking",
	"fixed",
	"enable_thinking",
	"effort_only"
];
/**
* How a model applies a system prompt that changes mid-conversation, spelled
* exactly as the harness spells it. `in-history` declares that the endpoint
* reads a `system`-role message at any position of the conversation as the
* complete effective prompt, so a changed prompt follows the cached history
* instead of rewriting the first message — the same declaration the first-party
* DeepSeek catalog makes, and one only a Messages endpoint can be asked for.
*/
const SYSTEM_PROMPT_UPDATES = ["in-history"];
/**
* How a model accepts tool declarations that change mid-conversation.
* `addition-only` declares that the endpoint activates a deferred tool when a
* later `system` message names it, so an added tool follows the cached history
* instead of rewriting the declaration list; `in-history` adds that a removed
* tool keeps its declaration and is deactivated the same way. Omission means
* every request declares the complete current list.
*/
const TOOL_UPDATES = ["addition-only", "in-history"];
/**
* Which published visual-token accounting an endpoint charges for one request
* image. The vocabulary exists because the number decides how much of the
* context window an image occupies, and the token meter can only price an image
* against the accounting of the route that will carry it: `area` charges a flat
* pixel grid (Claude bills one token per 750 pixels) and `tiles` charges a base
* plus a price per square tile covered (the OpenAI vision documentation). A
* route that declares neither keeps the meter's own structural heuristic.
*/
const IMAGE_TOKEN_KINDS = ["area", "tiles"];
/**
* Input modalities a model accepts; text is the assumption when none is
* declared. The vocabulary mirrors OWC's; `image` is carried as an inline
* base64 `image_url` part, and `video` is carried as a file handle until the
* harness has a video content block for a native part.
*/
const MODALITIES = [
	"text",
	"image",
	"video"
];
/**
* Default maximum idle interval between two stream events, in milliseconds.
* A gateway that stalls mid-response without closing the socket would
* otherwise hold a turn open forever.
*/
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Context capacity assumed for a model the profile does not size. The guess
* is deliberately generous rather than conservative: an oversized window costs
* a compaction that would have been unnecessary, while an undersized one
* refuses a request the endpoint would have accepted.
*/
const DEFAULT_CONTEXT_WINDOW = 256e3;
/**
* Output capacity a model the profile sizes nowhere falls back to, and the
* number a blank capacity field shows as inherited. It matches the cap the
* Anthropic Messages wire sends for a model no family speaks for, so the
* displayed default and the sent one are the same number.
*/
const DEFAULT_MAX_TOKENS = 65536;
/**
* Accumulated base64 image payload one request may carry. The default matches
* the official adapter's inline ceiling: beyond it a gateway that accepts the
* request at all tends to answer slowly or truncate, and the caller can do
* better by offloading the oldest occurrence.
*/
const DEFAULT_IMAGE_REQUEST_MAX_BYTES = 20971520;
/** Payload removed as one deterministic offload step. */
const DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM = 10485760;
const capabilities = z.object({
	/** Accepted input modalities; omission means text only. */
	modalities: z.array(z.union(MODALITIES)),
	/** Accepted reasoning-effort levels. */
	effort: z.array(z.union(EFFORT_LEVELS)),
	/** Accepted thinking modes. */
	thinking: z.array(z.union(THINKING_MODES)),
	/** How this model's endpoint spells the thinking switch. */
	thinkingStyle: z.union(THINKING_STYLES),
	/** Whether prior reasoning may be replayed through `reasoning_content`. */
	reasoningContent: z.boolean(),
	/** Whether prior reasoning is sent back; absent defers to the model's family. */
	replayReasoning: z.boolean(),
	/** Whether tool declarations may be sent to this model. */
	tools: z.boolean(),
	/** Whether the model answers with images of its own; refused on the protocol with no assistant image part. */
	imageOutput: z.boolean(),
	/** Whether the endpoint replays signed reasoning as its own encrypted item; the Responses wire requests and returns it verbatim. */
	responsesEncryptedReplay: z.boolean(),
	/** Whether the endpoint reads a mid-conversation system message as the effective prompt. */
	systemPromptUpdate: z.union(SYSTEM_PROMPT_UPDATES),
	/** Whether the endpoint activates and deactivates tools through mid-history messages. */
	toolUpdate: z.union(TOOL_UPDATES)
});
const modelDefaults = z.object({
	/** Sampling temperature written when the caller names none. */
	temperature: z.number().min(0).max(2),
	/** Nucleus cutoff written when the caller names none. */
	topP: z.number().min(0).max(1),
	/** Top-k cutoff written when the caller names none. */
	topK: z.number().step(1).min(1),
	/** Output cap asked for when the caller states none. */
	maxTokens: z.number().step(1).min(1)
});
const modelProfile = z.object({
	/** Exact model id sent on the wire. */
	id: z.string().required(),
	/** Display name for selection surfaces; defaults to the id. */
	name: z.string(),
	/** Context capacity in tokens; defaults to the route's `defaultContextWindow`. */
	contextWindow: z.number().step(1).min(1),
	/** Per-request output cap in tokens; defaults to the route's `defaultMaxTokens`. */
	maxTokens: z.number().step(1).min(1),
	/** Declared endpoint capabilities. */
	capabilities,
	/** Pixel budget request images are projected into; `low` selects the low-detail grid. */
	imagePixelBudget: z.union([z.number().step(1).min(1), z.const("low")]),
	/** Encoded-byte target for one request image. */
	imageMaxBytes: z.number().step(1).min(1),
	/**
	* Visual-token accounting this endpoint charges. The single-branch union is
	* what keeps the field absent when a profile omits it: a bare nested object
	* is materialized as `{}` and would then fail its own required `kind`.
	*/
	imageTokens: z.union([z.object({
		kind: z.union(IMAGE_TOKEN_KINDS).required(),
		per: z.number(),
		tile: z.number(),
		base: z.number(),
		perTile: z.number()
	})]),
	/** Request parameters this model sends when the caller states none. */
	defaults: modelDefaults
});
const providerProfile = z.object({
	/** Label shown by selection surfaces; defaults to the route key. */
	displayName: z.string(),
	/** Whether the route registers at all. */
	enabled: z.boolean().default(true),
	/** Wire protocol every model on this route speaks. */
	interfaceType: z.union(INTERFACE_TYPES),
	/** Official-format model configuration this route starts from. */
	catalog: z.union([z.string(), z.dict(z.any())]),
	/** Endpoint of every model on the route. */
	baseURL: z.string(),
	/** Credential reference resolved per request through the harness credential seam. */
	apiKeyEnv: z.string().role("credential-ref"),
	/** Inline credential; prefer `apiKeyEnv` on a managed deployment. */
	apiKey: z.string().role("secret"),
	/** Static request headers. */
	headers: z.dict(z.string()),
	/** Whether the route may use prompt caching. */
	promptCaching: z.boolean(),
	/** Whether a chat-completions request asks the endpoint to report usage in the stream. */
	includeUsage: z.boolean(),
	/** Extra top-level request-body fields. */
	extraBody: z.dict(z.any()),
	/** Concurrent requests this route serves before calls queue. */
	maxConcurrent: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3),
	/** Maximum idle interval between two stream events for this route, in milliseconds. */
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	/** Provider-owned retry policy executed by the agent's recovery layer. */
	retryPolicy: RetryPolicySchema,
	/** Models this route serves. */
	models: z.array(modelProfile),
	/** Context capacity for a route model that declares none. */
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	/** Output capability for a route model that declares none. */
	defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
	/** Accumulated base64 image payload one request carries before the oldest occurrences offload. */
	imageRequestMaxBytes: z.number().step(1).min(1),
	/** Image occurrences one request carries. */
	imageRequestMaxImages: z.number().step(1).min(1),
	/** Payload removed as one deterministic offload step. */
	imageOffloadByteQuantum: z.number().step(1).min(1),
	/** Occurrences removed as one deterministic offload step. */
	imageOffloadCountQuantum: z.number().step(1).min(1)
});
/**
* Runtime schema for {@link Options}: the provider routes this instance owns.
* The `providers` dict is volatile because a configuration surface may rewrite
* it live, which is what lets a stored profile change reach the next request
* without a remount.
*/
const Config = z.object({ 
/** Provider profiles keyed by the route name a request selects. */
providers: z.dict(providerProfile).default({}).volatile() });
//#endregion
//#region lib/types/profiles.js
/**
* Validation and resolution of configured provider profiles.
*
* Resolution is the one place that turns declarative profiles into the facts
* a request needs, so every default a deployment did not state is materialized
* here and nowhere else. Two validation modes exist because the two callers
* want opposite things from a bad profile: a write must be refused where it is
* written, while a stored read must keep serving the routes that still work —
* so a deferred resolution records a diagnostic on the offending route instead
* of throwing.
*
* @module dsh-llm-service-lite/profiles
*/
/** Protocol defaults OWC applies when a profile names no endpoint. */
const ENDPOINT_DEFAULTS = {
	"openai-chat-completions": "https://api.openai.com/v1",
	"anthropic-messages": "https://api.anthropic.com/v1",
	"openai-responses": "https://api.openai.com/v1"
};
/**
* Request-body keys a profile may not set through `extraBody`. The adapter
* owns each of them for a semantic reason — the conversation, the streaming
* contract, the tool declarations, or the usage report — so a silent overwrite
* would make a configured knob look applied while the adapter's value won.
*/
const RESERVED_BODY_KEYS = [
	"model",
	"messages",
	"stream",
	"stream_options",
	"tools",
	"system"
];
/**
* Materialize one declared visual-token accounting, refusing a declaration
* that does not state the whole of the accounting it named.
* @param provider - route name, for the diagnostic.
* @param model - model id, for the diagnostic.
* @param declared - the accounting the profile states.
* @returns the accounting in the form the pricing path reads.
* @throws Error naming the route, the model, and the field that is missing.
*/
function resolveImageTokens(provider, model, declared) {
	const at = `llm-service-lite: provider "${provider}" model "${model}" imageTokens`;
	if (!IMAGE_TOKEN_KINDS.includes(declared.kind)) throw new Error(`${at} names unknown kind "${declared.kind}"`);
	const positive = (value) => value !== void 0 && Number.isSafeInteger(value) && value >= 1;
	if (declared.kind === "area") {
		if (declared.tile !== void 0 || declared.base !== void 0 || declared.perTile !== void 0) throw new Error(`${at} of kind "area" also states the fields of "tiles"`);
		if (!positive(declared.per)) throw new Error(`${at} of kind "area" needs a positive integer "per"`);
		return {
			kind: "area",
			per: declared.per
		};
	}
	if (declared.per !== void 0) throw new Error(`${at} of kind "tiles" also states the field of "area"`);
	if (declared.base !== void 0 && !(Number.isSafeInteger(declared.base) && declared.base >= 0)) throw new Error(`${at} of kind "tiles" needs "base" to be a non-negative integer`);
	if (!positive(declared.perTile)) throw new Error(`${at} of kind "tiles" needs a positive integer "perTile"`);
	if (!positive(declared.tile)) throw new Error(`${at} of kind "tiles" needs a positive integer "tile"`);
	return {
		kind: "tiles",
		tile: declared.tile,
		base: declared.base ?? 0,
		perTile: declared.perTile
	};
}
/**
* Route names the first-party DeepSeek channel owns, and the package that owns
* each. DeepSeek keeps its official modules: the API-key and account routes are
* registered by `@deepseek-ai/dsh-llm-deepseek-*`, they authenticate through
* credentials this adapter has no part in, and they serve a request shape of
* their own. A profile that claimed one of these names could never serve it —
* registering a route another adapter already owns fails plugin loading — so
* the name is refused where it is written, with the owner named, instead of
* surfacing later as a registration failure that reads like a bug in this
* plugin. Any other route name remains available: a deployment that reaches a
* DeepSeek-compatible endpoint through this adapter names its own route and
* declares that endpoint's own capabilities.
*/
const RESERVED_ROUTE_OWNERS = {
	"deepseek-official": "@deepseek-ai/dsh-llm-deepseek-api-key",
	"deepseek-account": "@deepseek-ai/dsh-llm-deepseek-account"
};
/**
* Reject a route name the first-party channel owns.
* @param provider - route name a profile claimed.
* @throws Error naming the owner of the route.
*/
function assertRouteName(provider) {
	const owner = RESERVED_ROUTE_OWNERS[provider];
	if (owner === void 0) return;
	throw new Error(`llm-service-lite: provider route "${provider}" belongs to ${owner}; DeepSeek keeps the first-party channel, so describe another endpoint under a route name of your own`);
}
/**
* Reject a profile that names neither a usable protocol nor a usable endpoint.
* @param provider - route name, for the diagnostic.
* @param source - configured profile.
* @returns the protocol this adapter serves for the profile.
* @throws Error naming the route and the field that cannot be served.
*/
function assertAddressable(provider, source) {
	assertRouteName(provider);
	if (source.interfaceType === void 0) throw new Error(`llm-service-lite: provider "${provider}" names no interfaceType; state one of ${INTERFACE_TYPES.join(", ")} or point "catalog" at an official provider file`);
	if (!INTERFACE_TYPES.includes(source.interfaceType)) throw new Error(`llm-service-lite: provider "${provider}" names interfaceType "${source.interfaceType}", which is not one of ${INTERFACE_TYPES.join(", ")}`);
	if (source.baseURL !== void 0) {
		if (source.baseURL.length === 0) throw new Error(`llm-service-lite: provider "${provider}" has an empty baseURL`);
		let parsed;
		try {
			parsed = new URL(source.baseURL);
		} catch (_invalidUrl) {
			throw new Error(`llm-service-lite: provider "${provider}" baseURL is not a URL`);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`llm-service-lite: provider "${provider}" baseURL must use http or https`);
	}
	if (source.displayName !== void 0 && source.displayName.length === 0) throw new Error(`llm-service-lite: provider "${provider}" has an empty displayName`);
	if (source.apiKeyEnv !== void 0 && source.apiKey !== void 0) throw new Error(`llm-service-lite: provider "${provider}" sets both apiKeyEnv and apiKey; name the credential once so the request cannot authenticate with an unintended one`);
	assertRouteCapabilities(provider, source);
	assertExtraBody(provider, source.extraBody);
	for (const [name, value] of Object.entries(source.headers ?? {})) try {
		new Headers([[name, value]]);
	} catch (_invalidHeader) {
		throw new Error(`llm-service-lite: provider "${provider}" header "${name}" is not valid for Fetch; use a valid HTTP field name and a single-line value representable as bytes`);
	}
	return source.interfaceType;
}
/** Reject route-level capability switches the named protocol cannot carry. */
function assertRouteCapabilities(provider, source) {
	if (source.promptCaching === true && source.interfaceType !== "anthropic-messages") throw new Error(`llm-service-lite: provider "${provider}" sets promptCaching on interfaceType "${source.interfaceType}"; only anthropic-messages marks cache breakpoints through the request body`);
	if (source.includeUsage === true && source.interfaceType !== "openai-chat-completions") throw new Error(`llm-service-lite: provider "${provider}" sets includeUsage on interfaceType "${source.interfaceType}"; only openai-chat-completions reports usage through stream_options`);
}
/** Reject extra body fields that are not JSON, or that the adapter owns. */
function assertExtraBody(provider, extraBody) {
	for (const [key, value] of Object.entries(extraBody ?? {})) {
		if (RESERVED_BODY_KEYS.includes(key)) throw new Error(`llm-service-lite: provider "${provider}" extraBody sets reserved field "${key}"; the adapter owns ${RESERVED_BODY_KEYS.join(", ")}`);
		if (!isJsonValue(value)) throw new Error(`llm-service-lite: provider "${provider}" extraBody field "${key}" is not a JSON value`);
	}
}
/** The request parameters a model may declare a default for. */
const DEFAULT_PARAM_FIELDS = [
	"temperature",
	"topP",
	"topK",
	"maxTokens"
];
/**
* Validate one model's declared request parameters against the protocol that
* would carry them. Ranges are the schema's work; this refuses what a raw
* profile could still state — a value no request can send, and a knob the
* named protocol has no field for.
* @param provider - route name, for the diagnostic.
* @param modelId - model id, for the diagnostic.
* @param declared - configured request defaults, if any.
* @param interfaceType - protocol every request on this route speaks.
* @returns the defaults the request path writes, each absent unless declared.
* @throws Error naming the field a request could not carry.
*/
function resolveModelDefaults(provider, modelId, declared, interfaceType) {
	const source = declared ?? {};
	if (source.topK !== void 0 && interfaceType === "openai-responses") throw new Error(`llm-service-lite: provider "${provider}" model "${modelId}" declares defaults.topK on interfaceType "openai-responses"; that protocol has no top-k field`);
	for (const field of DEFAULT_PARAM_FIELDS) {
		const value = source[field];
		if (value === void 0 || Number.isFinite(value)) continue;
		throw new Error(`llm-service-lite: provider "${provider}" model "${modelId}" declares defaults.${field} "${String(value)}"; a request parameter must be a finite number`);
	}
	return {
		temperature: source.temperature,
		topP: source.topP,
		topK: source.topK,
		maxTokens: source.maxTokens
	};
}
/**
* Materialize one declared model's capacities and capabilities.
* @param provider - route name, for the diagnostic.
* @param model - configured model entry.
* @param fallbackContextWindow - route context capacity for an unsized model.
* @param fallbackMaxTokens - route output capability for an unsized model.
* @returns the model as the request path reads it.
*/
function resolveModel(provider, model, interfaceType, fallbackContextWindow, fallbackMaxTokens) {
	if (model.id.length === 0) throw new Error(`llm-service-lite: provider "${provider}" has a model with an empty id`);
	if (model.name !== void 0 && model.name.length === 0) throw new Error(`llm-service-lite: provider "${provider}" model "${model.id}" has an empty name`);
	const capabilities = model.capabilities ?? {};
	const modalities = capabilities.modalities ?? [];
	const maxTokens = model.maxTokens ?? fallbackMaxTokens;
	for (const modality of modalities) if (!MODALITIES.includes(modality)) throw new Error(`llm-service-lite: provider "${provider}" model "${model.id}" declares unknown modality "${modality}"`);
	const carriesImages = modalities.includes("image");
	if (model.imagePixelBudget !== void 0 && !carriesImages) throw new Error(`llm-service-lite: provider "${provider}" model "${model.id}" sets imagePixelBudget without declaring image input`);
	if (model.imageMaxBytes !== void 0 && !carriesImages) throw new Error(`llm-service-lite: provider "${provider}" model "${model.id}" sets imageMaxBytes without declaring image input`);
	if (model.imageTokens !== void 0 && !carriesImages) throw new Error(`llm-service-lite: provider "${provider}" model "${model.id}" sets imageTokens without declaring image input`);
	if (capabilities.imageOutput === true && interfaceType === "anthropic-messages") throw new Error(`llm-service-lite: provider "${provider}" model "${model.id}" declares image output on interfaceType "anthropic-messages"; that protocol has no assistant image part`);
	if (capabilities.systemPromptUpdate !== void 0 || capabilities.toolUpdate !== void 0) {
		const declared = capabilities.systemPromptUpdate !== void 0 ? "systemPromptUpdate" : "toolUpdate";
		if (interfaceType !== "anthropic-messages") throw new Error(`llm-service-lite: provider "${provider}" model "${model.id}" declares ${declared} on interfaceType "${interfaceType}"; only anthropic-messages carries a mid-history system message`);
		if (capabilities.systemPromptUpdate !== void 0 && !SYSTEM_PROMPT_UPDATES.includes(capabilities.systemPromptUpdate)) throw new Error(`llm-service-lite: provider "${provider}" model "${model.id}" declares unknown systemPromptUpdate "${capabilities.systemPromptUpdate}"`);
		if (capabilities.toolUpdate !== void 0 && !TOOL_UPDATES.includes(capabilities.toolUpdate)) throw new Error(`llm-service-lite: provider "${provider}" model "${model.id}" declares unknown toolUpdate "${capabilities.toolUpdate}"`);
	}
	const family = familyFactsOf(model.id);
	if (family.replayRequired && capabilities.replayReasoning === false) throw new Error(`llm-service-lite: provider "${provider}" model "${model.id}" turns off reasoning replay, but family "${family.family}" requires it on every follow-up turn`);
	const replayReasoning = family.replayRequired ? true : capabilities.replayReasoning ?? capabilities.reasoningContent ?? family.replayReasoning;
	const effort = capabilities.effort === void 0 || capabilities.effort.length === 0 ? [...family.effort] : [...capabilities.effort];
	const thinking = capabilities.thinking === void 0 || capabilities.thinking.length === 0 ? [...family.thinking] : [...capabilities.thinking];
	return {
		id: model.id,
		name: model.name ?? model.id,
		contextWindow: model.contextWindow ?? fallbackContextWindow,
		maxTokens,
		defaults: resolveModelDefaults(provider, model.id, model.defaults, interfaceType),
		family: family.family,
		modalities: modalities.length === 0 ? [...family.modalities] : [...modalities],
		effort,
		effortDefault: capabilities.effort === void 0 || capabilities.effort.length === 0 ? family.effortDefault : void 0,
		thinking,
		thinkingStyle: capabilities.thinkingStyle ?? family.thinkingStyle,
		reasoningContent: capabilities.reasoningContent ?? family.reasoningContent,
		replayReasoning,
		replayRequired: family.replayRequired,
		encryptedReplay: capabilities.responsesEncryptedReplay ?? false,
		systemPromptUpdate: capabilities.systemPromptUpdate,
		toolUpdate: capabilities.toolUpdate,
		tools: capabilities.tools ?? true,
		imagePixelBudget: model.imagePixelBudget === "low" ? LOW_DETAIL_IMAGE_PIXEL_BUDGET : model.imagePixelBudget,
		imageMaxBytes: model.imageMaxBytes,
		imageTokens: model.imageTokens === void 0 ? void 0 : resolveImageTokens(provider, model.id, model.imageTokens),
		imageOutput: capabilities.imageOutput ?? false
	};
}
/**
* Resolve every configured profile into the facts the adapter serves.
*
* A disabled profile resolves like any other and is reported with
* `enabled: false`: the route does not register, but configuration surfaces
* still address it by name, which is what lets a deployment switch a provider
* off without losing what it had configured.
*
* @param providers - configured profiles keyed by route name.
* @param validation - `strict` refuses an unserviceable profile; `deferred` keeps it with a diagnostic.
* @returns resolved profiles in configuration order, keyed by route name.
* @throws Error in `strict` mode naming the route and field that cannot be served.
*/
function resolveProfiles(providers, validation = "strict") {
	if (Array.isArray(providers)) throw new Error("llm-service-lite: providers is a dict keyed by provider route, not an array of profiles");
	const resolved = /* @__PURE__ */ new Map();
	for (const [provider, rawSource] of Object.entries(providers ?? {})) {
		if (provider.length === 0) throw new Error("llm-service-lite: provider route names must be non-empty");
		if (resolved.has(provider)) throw new Error(`llm-service-lite: duplicate provider route "${provider}"`);
		let source;
		let catalogDiagnostics;
		try {
			({profile: source, diagnostics: catalogDiagnostics} = materializeCatalog(provider, rawSource));
		} catch (error) {
			if (validation === "strict") throw error;
			resolved.set(provider, unserviceable(provider, rawSource, error));
			continue;
		}
		let interfaceType;
		try {
			interfaceType = assertAddressable(provider, source);
		} catch (error) {
			if (validation === "strict") throw error;
			resolved.set(provider, unserviceable(provider, source, error));
			continue;
		}
		const defaultContextWindow = source.defaultContextWindow ?? 256e3;
		const defaultMaxTokens = source.defaultMaxTokens ?? 65536;
		let models;
		try {
			models = (source.models ?? []).map((model) => resolveModel(provider, model, interfaceType, defaultContextWindow, defaultMaxTokens));
			const ids = /* @__PURE__ */ new Set();
			for (const model of models) {
				if (ids.has(model.id)) throw new Error(`llm-service-lite: provider "${provider}" declares model "${model.id}" twice`);
				ids.add(model.id);
			}
		} catch (error) {
			if (validation === "strict") throw error;
			resolved.set(provider, unserviceable(provider, source, error));
			continue;
		}
		resolved.set(provider, {
			provider,
			displayName: source.displayName ?? provider,
			enabled: source.enabled ?? true,
			interfaceType,
			baseURL: source.baseURL ?? ENDPOINT_DEFAULTS[interfaceType],
			apiKeyEnv: source.apiKeyEnv === void 0 ? void 0 : credentialRef(source.apiKeyEnv),
			apiKey: source.apiKey,
			headers: { ...source.headers },
			promptCaching: source.promptCaching ?? false,
			includeUsage: source.includeUsage ?? false,
			extraBody: { ...source.extraBody },
			maxConcurrent: source.maxConcurrent ?? 3,
			streamIdleTimeoutMs: source.streamIdleTimeoutMs ?? 3e5,
			retryPolicy: resolveRetryPolicy(source.retryPolicy, `llm-service-lite: provider "${provider}" retryPolicy`),
			models,
			defaultContextWindow,
			defaultMaxTokens,
			imageRequestBudget: {
				representation: "base64",
				maxBytes: source.imageRequestMaxBytes ?? 20971520,
				maxImages: source.imageRequestMaxImages ?? 600,
				byteQuantum: source.imageOffloadByteQuantum ?? 10485760,
				countQuantum: source.imageOffloadCountQuantum ?? 20
			},
			diagnostic: void 0,
			catalogDiagnostics
		});
	}
	return resolved;
}
/** Whether one converted capacity is what the harness's model-info contract accepts. */
function isPositiveSafeInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
/**
* The schema's own bounds for one request-parameter default. A converted
* profile never meets the schema, so the same rules are applied to its values.
*/
const CONVERTED_DEFAULT_BOUNDS = {
	temperature: (value) => value >= 0 && value <= 2,
	topP: (value) => value >= 0 && value <= 1,
	topK: (value) => Number.isSafeInteger(value) && value >= 1,
	maxTokens: (value) => Number.isSafeInteger(value) && value >= 1
};
/**
* Sanitize the facts one official catalog conversion produced, dropping values
* the Config schema would have policed had they been declared directly.
*
* The conversion reads a user-supplied file, so its output has never been
* through this package's schema. A capacity the harness later rejects would
* take down `resolveModelInfo`/`prepareCall` for the whole route
* (`INVALID_MODEL_CONTEXT` / `INVALID_MODEL_MAX_TOKENS`), and a non-string
* header would throw a raw `TypeError` when a request builds its headers. Each
* dropped value is reported once, beside the conversion's own diagnostics, so
* the route still serves with everything the file did state validly.
* @param provider - route name, for diagnostics.
* @param profile - the converted profile, before the configured fields layer on top.
* @param interfaceType - protocol the materialized route will actually speak, which
*   may be the profile's own override rather than the converted one.
* @returns the profile without values no request could carry, and one diagnostic per drop.
*/
function validateConvertedCatalog(provider, profile, interfaceType) {
	const prefix = `llm-service-lite: provider "${provider}" catalog`;
	const diagnostics = [];
	const report = (message) => {
		diagnostics.push(`${prefix} ${message}`);
	};
	const { headers: declaredHeaders, models: declaredModels, ...route } = profile;
	let headers = declaredHeaders;
	if (headers !== void 0) {
		const unusable = Object.entries(headers).filter(([, value]) => typeof value !== "string");
		if (unusable.length > 0) {
			report(`${unusable.map(([name]) => `header "${name}"`).join(", ")} ${unusable.length === 1 ? "is" : "are"} not a string; the route declares no catalog headers`);
			headers = void 0;
		}
	}
	const models = declaredModels.map((model) => {
		const { contextWindow: declaredContextWindow, maxTokens: declaredMaxTokens, defaults: declaredDefaults, ...rest } = model;
		let contextWindow = declaredContextWindow;
		if (declaredContextWindow !== void 0 && !isPositiveSafeInteger(declaredContextWindow)) {
			report(`model "${model.id}" contextWindow "${String(declaredContextWindow)}" is not a positive integer; the capacity is not carried`);
			contextWindow = void 0;
		}
		let maxTokens = declaredMaxTokens;
		if (declaredMaxTokens !== void 0 && !isPositiveSafeInteger(declaredMaxTokens)) {
			report(`model "${model.id}" maxTokens "${String(declaredMaxTokens)}" is not a positive integer; the capacity is not carried`);
			maxTokens = void 0;
		}
		let defaults;
		if (declaredDefaults !== void 0) {
			const kept = {};
			for (const field of [
				"temperature",
				"topP",
				"topK",
				"maxTokens"
			]) {
				const value = declaredDefaults[field];
				if (value === void 0) continue;
				if (field === "topK" && interfaceType === "openai-responses") {
					report(`model "${model.id}" defaults.topK is not carried on interfaceType "openai-responses"; that protocol has no top-k field`);
					continue;
				}
				if (!CONVERTED_DEFAULT_BOUNDS[field](value)) {
					report(`model "${model.id}" defaults.${field} "${String(value)}" is outside the range the profile schema accepts; the default is not carried`);
					continue;
				}
				kept[field] = value;
			}
			if (Object.keys(kept).length > 0) defaults = kept;
		}
		return {
			...rest,
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxTokens === void 0 ? {} : { maxTokens },
			...defaults === void 0 ? {} : { defaults }
		};
	});
	return {
		profile: {
			...route,
			...headers === void 0 ? {} : { headers },
			models
		},
		diagnostics
	};
}
/**
* Materialize one profile's official-format catalog, when it names one.
*
* The conversion supplies the profile's protocol, endpoint, headers, and
* models; every field the profile states itself wins over the converted value,
* which is what lets one file describe a route while the deployment overrides
* its credential, its endpoint, or its model list. The catalog field itself is
* spent: what the route serves is the converted facts.
*
* @param provider - route name, for diagnostics.
* @param source - configured profile.
* @returns the profile the request path reads, and the conversion's diagnostics.
* @throws Error when the catalog cannot be read or cannot become one route profile.
*/
function materializeCatalog(provider, source) {
	const catalog = source.catalog;
	if (catalog === void 0) return {
		profile: source,
		diagnostics: []
	};
	let content;
	if (typeof catalog === "string") try {
		content = JSON.parse(readFileSync(catalog, "utf8"));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`llm-service-lite: provider "${provider}" catalog "${catalog}" cannot be read: ${detail}`);
	}
	else content = catalog;
	const converted = convertOfficialProvider(content, provider);
	const validated = validateConvertedCatalog(provider, converted.profile, source.interfaceType ?? converted.profile.interfaceType);
	const declaredModels = source.models ?? [];
	return {
		profile: {
			...validated.profile,
			...source,
			interfaceType: source.interfaceType ?? validated.profile.interfaceType,
			models: declaredModels.length === 0 ? validated.profile.models : declaredModels
		},
		diagnostics: [...converted.diagnostics, ...validated.diagnostics]
	};
}
/**
* One profile that cannot serve, kept addressable by configuration surfaces.
* @param provider - route name.
* @param source - configured profile.
* @param error - the failure that made it unserviceable.
* @returns a resolved profile carrying the diagnostic and safe placeholder facts.
*/
function unserviceable(provider, source, error) {
	const message = error instanceof Error ? error.message : String(error);
	return {
		provider,
		displayName: source.displayName ?? provider,
		enabled: source.enabled ?? true,
		interfaceType: INTERFACE_TYPES.includes(source.interfaceType ?? "") ? source.interfaceType : "openai-chat-completions",
		baseURL: source.baseURL ?? ENDPOINT_DEFAULTS["openai-chat-completions"],
		apiKeyEnv: void 0,
		apiKey: void 0,
		headers: {},
		promptCaching: false,
		includeUsage: false,
		extraBody: {},
		maxConcurrent: 3,
		streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "llm-service-lite: unserviceable provider"),
		models: [],
		defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
		defaultMaxTokens: DEFAULT_MAX_TOKENS,
		imageRequestBudget: {
			representation: "base64",
			maxBytes: DEFAULT_IMAGE_REQUEST_MAX_BYTES,
			maxImages: 600,
			byteQuantum: DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
			countQuantum: 20
		},
		diagnostic: message,
		catalogDiagnostics: []
	};
}
/**
* The facts the LLM registry captures when a route is registered, in a form
* that compares by value: a change here must re-register, and merely reordering
* the configuration must not.
*
* Only registry-captured state belongs here. Concurrency is deliberately
* absent: the registration captures the route's display metadata and retry
* policy, while the admission limiter is re-tuned in place on the next request,
* so editing `maxConcurrent` needs no route replacement.
* @param profiles - resolved profiles.
* @returns route facts sorted by route name.
*/
function registrationFacts(profiles) {
	return [...profiles.values()].filter((profile) => profile.enabled && profile.diagnostic === void 0).map((profile) => ({
		provider: profile.provider,
		displayName: profile.displayName,
		retryPolicy: profile.retryPolicy
	})).sort((left, right) => left.provider.localeCompare(right.provider));
}
/**
* The routes a resolution should register: enabled profiles that can serve.
* @param profiles - resolved profiles.
* @returns route names in configuration order.
*/
function serviceableRoutes(profiles) {
	return [...profiles.values()].filter((profile) => profile.enabled && profile.diagnostic === void 0).map((profile) => profile.provider);
}
/**
* The declared model, or the route's own defaults for an id it does not list.
* Core routing accepts any model id, so an unlisted one is served from the
* route's declared capacities rather than refused.
* @param profile - resolved route.
* @param model - exact model id from the request.
* @returns the model facts a request uses.
*/
function modelOf(profile, model) {
	const listed = profile.models.find((entry) => entry.id === model);
	if (listed !== void 0) return listed;
	const family = familyFactsOf(model);
	return {
		id: model,
		name: model,
		contextWindow: profile.defaultContextWindow,
		maxTokens: profile.defaultMaxTokens,
		defaults: {
			temperature: void 0,
			topP: void 0,
			topK: void 0,
			maxTokens: void 0
		},
		...family,
		modalities: [...family.modalities],
		effort: [...family.effort],
		thinking: [...family.thinking],
		imagePixelBudget: void 0,
		imageMaxBytes: void 0,
		imageTokens: void 0,
		imageOutput: false,
		encryptedReplay: false,
		systemPromptUpdate: void 0,
		toolUpdate: void 0,
		tools: true
	};
}
/**
* The facts one model id's family supplies, or the empty answer when no family
* speaks for it. Both entry points read them the same way, so a listed model
* and an id the route never enumerated cannot drift apart.
* @param model - exact model id from the request.
* @returns family-derived facts, already in resolved form.
*/
function familyFactsOf(model) {
	const rule = modelDefaultRuleOf(model);
	const replayRequired = rule?.replayRequired === true;
	return {
		family: rule?.family,
		modalities: rule?.modalities ?? ["text"],
		effort: rule?.effort ?? [],
		effortDefault: rule?.effortDefault,
		thinking: rule?.thinking ?? [],
		thinkingStyle: rule?.thinkingStyle,
		reasoningContent: rule?.reasoningContent ?? false,
		replayReasoning: replayRequired || (rule?.replayReasoning ?? rule?.reasoningContent ?? false),
		replayRequired
	};
}
/**
* Reject profiles that cannot be served, while letting an unchanged stored
* profile through: a configuration that already worked must stay editable
* after this adapter's own rules tighten, and only the entries an operation
* actually touches are re-validated.
* @param config - the resolved section to check.
* @param previous - the section already in force; omission checks every provider.
* @throws Error naming the route and field that cannot be served.
*/
function assertServiceable(config, previous) {
	const providers = config.providers ?? {};
	const previousProviders = previous?.providers;
	const changed = Object.entries(providers).filter(([provider, profile]) => previousProviders?.[provider] === void 0 || !deepEqualJson(profile, previousProviders[provider]));
	const enforced = {};
	for (const [provider, profile] of changed) if (profile.enabled === false) resolveProfiles({ [provider]: profile }, "deferred");
	else enforced[provider] = profile;
	resolveProfiles(enforced);
}
//#endregion
//#region lib/types/models.js
/**
* Projection of resolved profiles onto the LLM seam's model vocabulary.
*
* OWC describes a model's thinking in two independent knobs — a mode
* (`adaptive` / `enabled` / `disabled`) and a reasoning-effort level — while
* the harness exposes one selector, `GenerateOptions.reasoningEffort`. The
* mapping keeps both knobs reachable without inventing a second selector: a
* model that declares effort levels offers those levels, and a model that
* declares only thinking modes offers the modes themselves. A request then
* carries whatever the chosen level means on that endpoint, which is exactly
* what {@link reasoningLevelOf} answers.
*
* @module dsh-llm-service-lite/models
*/
/** Human-readable labels for the levels the adapter offers. */
const LEVEL_LABELS = {
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
	ultra: "Ultra",
	adaptive: "Adaptive",
	enabled: "Enabled",
	disabled: "Disabled"
};
/**
* Reasoning levels one model offers, in declaration order.
*
* Effort levels win when both are declared: they are the finer control, and a
* model that publishes them almost always accepts the mode toggle implicitly
* (an effort is sent for a thinking request, nothing is sent for a plain one).
* @param model - resolved model facts.
* @returns selectable levels, empty when the model exposes no reasoning control.
*/
function reasoningLevels(model) {
	if (model.effort.length > 0) return model.effort;
	return model.thinking;
}
/**
* The wire meaning of one selected level.
*
* @param model - resolved model facts.
* @param level - the selected level, or undefined when the caller named none.
* @returns the effort spelling for `reasoning_effort`, the thinking mode the
* request should declare, and whether thinking is on; every field is omitted
* when the level means "send nothing".
*/
function reasoningLevelOf(model, level) {
	if (level === void 0) return {};
	if (model.effort.includes(level)) return {
		effort: level,
		thinking: true
	};
	if (model.thinking.includes(level)) return level === "disabled" ? {
		mode: "disabled",
		thinking: false
	} : {
		mode: level,
		thinking: true
	};
	return {};
}
/**
* Whether a model's route can replay prior reasoning for the next request.
* @param model - resolved route.
* @returns true when the route carries reasoning content and sends it back.
*/
function replaysReasoning(model) {
	return model.replayReasoning && model.reasoningContent;
}
/**
* The reasoning level one request should act on: the caller's own when it
* named one, else the level the model's family applies by default.
* @param model - resolved route.
* @param requested - the level the caller named, when any.
* @returns the level to interpret, or undefined to send nothing.
*/
function reasoningLevelFor(model, requested) {
	return requested ?? model.effortDefault;
}
/**
* The advisory catalog entry for one model.
* @param profile - resolved route.
* @param model - resolved model facts.
* @returns the seam's model info.
*/
function outputModalitiesOf(model) {
	return model.imageOutput ? ["text", "image"] : ["text"];
}
/**
* The modalities one model's answers may carry. A model that declared image
* output answers with text and images; every other model is declared text-only
* rather than left unknown, so an image block from a route that never claimed
* one is a failure a caller can see.
* @param profile - resolved route.
* @param model - resolved model facts.
* @returns the seam's model info.
*/
function catalogInfo(profile, model) {
	return {
		provider: profile.provider,
		id: model.id,
		name: model.name,
		inputModalities: [...model.modalities],
		outputModalities: [...outputModalitiesOf(model)]
	};
}
/**
* Every model a route advertises, in configuration order.
* @param profile - resolved route.
* @returns catalog entries for the route's declared models.
*/
function catalogModels(profile) {
	return profile.models.map((model) => catalogInfo(profile, model));
}
/**
* Complete metadata for one exact model, including the capacities and the
* reasoning selector the request path reads before a call is prepared.
* @param profile - resolved route.
* @param model - exact model id from the request.
* @returns the seam's resolved model info.
*/
function resolvedModelInfo(profile, model) {
	const facts = modelOf(profile, model);
	const levels = reasoningLevels(facts);
	return {
		provider: profile.provider,
		id: facts.id,
		name: facts.name,
		inputModalities: [...facts.modalities],
		outputModalities: [...outputModalitiesOf(facts)],
		context: { contextWindow: facts.contextWindow },
		...facts.defaults.maxTokens === void 0 ? {} : { defaultMaxTokens: facts.defaults.maxTokens },
		...facts.systemPromptUpdate === void 0 ? {} : { systemPromptUpdate: facts.systemPromptUpdate },
		...facts.toolUpdate === void 0 ? {} : { toolUpdate: facts.toolUpdate },
		...levels.length === 0 ? {} : { reasoning: {
			efforts: levels.map((level) => ({
				id: ReasoningEffortId(level),
				name: LEVEL_LABELS[level] ?? level
			})),
			...facts.effortDefault === void 0 ? {} : { defaultEffort: ReasoningEffortId(facts.effortDefault) }
		} }
	};
}
//#endregion
//#region lib/types/anthropic-messages.js
/**
* The `anthropic-messages` wire: request assembly and the pairing repair every
* durable history needs before it crosses this protocol.
*
* Two rules of the Messages API are not properties of the conversation but of
* the request, and a durable session can violate both: every `tool_use` block
* must be answered by exactly one `tool_result`, and that result must arrive in
* the user turn that immediately follows its call. A history written across an
* interrupted turn, a crash, or a compaction boundary can carry a result whose
* call is gone, two results for one call, or a call nothing ever answered —
* and the endpoint answers any of them with a 400 rather than a completion.
* The translation therefore repairs the pairing on the way out: orphan results
* are dropped, a repeated call id or result id collapses to its first
* occurrence, an unanswered call is answered with a placeholder, and the
* results of one parallel batch merge into the single user turn the protocol
* requires. The endpoint then reads a request it would have accepted from a
* well-formed conversation, without the durable log being rewritten.
*
* The other half of the port is replay fidelity: this protocol returns signed
* thinking blocks, and returning a turn without its signature is itself a 400.
* A signature is kept as adapter-private replay metadata on the assistant
* message — the one place the harness reserves for exactly this — and is read
* back only for the provider and model that produced it.
*
* @module dsh-llm-service-lite/anthropic-messages
*/
/** `anthropic-version` this transport speaks; the API requires the header. */
const ANTHROPIC_VERSION$1 = "2023-06-01";
/** What one unanswered call is answered with, so the protocol's pairing holds. */
const MISSING_RESULT_TEXT = "Tool result missing: this call did not complete.";
/**
* What one assistant turn contributes when nothing else survives translation —
* a turn whose reasoning had no usable signature and whose calls were already
* declared earlier. The protocol refuses an empty content array, and this
* states the omission to the model instead of inventing a sentence for it.
*/
const TRIMMED_TURN_TEXT = "[context trimmed]";
/** Replay-metadata kinds this transport writes and reads. */
const REPLAY_KIND = "llm-service-lite-anthropic";
/** Joined text of the blocks a message contributes as text. */
function textOf$2(message) {
	return message.content.flatMap((block) => block.type === "text" ? [block.text ?? ""] : []).join("");
}
/**
* The replay metadata of one assistant message, when this route may use it.
*
* Every mismatch degrades the message to provider-neutral history instead of
* failing the request: a signature is bound to both the provider and the model
* that issued it, another adapter's metadata means nothing here, and a
* truncated envelope cannot be aligned with the content it decorated. The
* degradation costs the thinking text of that one turn — an unsigned thinking
* block is rejected outright — while the text and the calls survive.
*
* @param message - durable assistant message with optional adapter-private replay metadata.
* @param provider - route this request is addressed to.
* @param model - exact model this request is addressed to.
* @returns one entry per durable content block, or undefined when none applies.
*/
function replayBlocksOf$1(message, provider, model) {
	const source = message.source;
	if (source.provider !== provider || source.model !== model) return void 0;
	const envelope = source.replayState;
	if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return void 0;
	const record = envelope;
	const response = record["response"];
	if (typeof response !== "object" || response === null || Array.isArray(response)) return void 0;
	const facts = response;
	if (facts["kind"] !== "llm-service-lite-anthropic" || facts["version"] !== 1) return void 0;
	const blocks = record["blocks"];
	if (!Array.isArray(blocks) || blocks.length !== message.content.length) return void 0;
	const entries = blocks;
	for (const [position, block] of message.content.entries()) {
		const entry = entries[position];
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return void 0;
		const replay = entry;
		if (replay["type"] !== block.type) return void 0;
		if (block.type !== "reasoning") continue;
		for (const signature of ["signature", "redacted"]) {
			const value = replay[signature];
			if (value !== void 0 && typeof value !== "string") return void 0;
		}
	}
	return entries;
}
/**
* Read the calls and the results of one history.
* @param messages - complete request inputs.
* @returns the first result per call id, and every declared call id.
*/
function scanPairings$1(messages) {
	const outputs = /* @__PURE__ */ new Map();
	const calls = /* @__PURE__ */ new Set();
	for (const message of messages) {
		if (message.role === "tool") {
			const id = String(message.toolCallId);
			if (outputs.has(id)) continue;
			outputs.set(id, {
				text: textOf$2(message),
				isError: message.isError === true,
				media: message.content.flatMap((block) => block.type === "image" ? [block] : [])
			});
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "tool-call") calls.add(String(block.id));
	}
	return {
		outputs,
		calls
	};
}
/**
* The `source` one retained image travels as: base64 inline, because a
* gateway-reachable URL is not something this adapter can assume.
* @param version - request bytes read from the attachment provider.
* @returns the protocol's base64 source object.
*/
function imageSource(version) {
	return {
		type: "base64",
		media_type: version.mediaType,
		data: Buffer.from(version.data).toString("base64")
	};
}
/**
* One image occurrence as a part: its bytes, or the placeholder text an
* offloaded occurrence left in its place.
* @param block - durable image occurrence.
* @param versions - prepared request versions, keyed by durable attachment id.
* @returns the protocol part.
* @throws LlmError `INVALID_CONFIG` when a retained occurrence has no prepared version.
*/
function imagePart$1(block, versions) {
	if (block.offloaded === true) return {
		type: "text",
		text: offloadedImageText$1(block)
	};
	const version = versions.get(block.attachment.attachmentId);
	if (version === void 0) throw new LlmError("llm-service-lite: a retained image occurrence reached the wire without a prepared request version", "INVALID_CONFIG");
	return {
		type: "image",
		source: imageSource(version)
	};
}
/** One user turn's parts, with every image resolved and unknown blocks skipped. */
function userParts$1(content, versions) {
	const parts = [];
	for (const block of content) {
		if (block.type === "text") {
			if (block.text.length > 0) parts.push({
				type: "text",
				text: block.text
			});
			continue;
		}
		if (block.type === "image") parts.push(imagePart$1(block, versions));
	}
	return parts;
}
/** Tool arguments as the protocol's `input` object; a malformed payload sends `{}` rather than an invalid request. */
function toolInput(argumentsText) {
	try {
		const parsed = JSON.parse(argumentsText);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
	} catch (_malformedArguments) {}
	return {};
}
/**
* One tool result, with the media the result carried inlined beside its text.
* @param id - call id this result answers.
* @param output - the result as the durable log holds it, when it holds one.
* @param versions - prepared request versions, keyed by durable attachment id.
* @returns the protocol part.
*/
function toolResultPart(id, output, versions) {
	if (output === void 0) return {
		type: "tool_result",
		tool_use_id: id,
		content: MISSING_RESULT_TEXT
	};
	return {
		type: "tool_result",
		tool_use_id: id,
		content: output.media.length === 0 ? output.text : [{
			type: "text",
			text: output.text
		}, ...output.media.map((block) => imagePart$1(block, versions))],
		...output.isError ? { is_error: true } : {}
	};
}
/** One reasoning block as it goes back on the wire, or nothing when it cannot be signed. */
function reasoningPart(text, replay) {
	if (replay === void 0 || replay.type !== "reasoning") return void 0;
	if (replay.redacted !== void 0) return {
		type: "redacted_thinking",
		data: replay.redacted
	};
	if (replay.signature === void 0 || replay.signature.length === 0) return void 0;
	return {
		type: "thinking",
		thinking: text,
		signature: replay.signature
	};
}
/**
* Translate the durable history into Messages wire messages.
*
* A route that declared `systemPromptUpdate` or `toolUpdate` gets those
* changes on the wire this protocol spells them: a `system`-role message at
* the position the change belongs to, carrying the prompt snapshot and the
* tool references that activate or deactivate a declared tool. The message is
* held back until the turn it follows is a user turn, because this protocol
* reads a system message as an instruction between turns rather than as a
* sibling of one. Every other route keeps the folding rule below.
*
* @param options - the assembled request.
* @param provider - route this request is addressed to, for replay matching.
* @param model - the route's declared facts for this model, including replay identity and the two mid-history capabilities.
* @param versions - prepared request images, keyed by durable attachment id.
* @returns protocol messages in conversation order, always ending on a user turn
*   once a call has been made in them.
*/
function toAnthropicMessages(options, provider, model, versions) {
	const messages = options.messages;
	const { outputs, calls } = scanPairings$1(messages);
	const declared = /* @__PURE__ */ new Set();
	const answered = /* @__PURE__ */ new Set();
	let pending = [];
	let batch = [];
	const out = [];
	/** Whether a mid-history change travels as the `system` message this protocol reserves for it. */
	const inHistory = model.systemPromptUpdate === "in-history" || model.toolUpdate !== void 0;
	let updates = [];
	/**
	* Place the queued mid-history changes. They belong between the user turn
	* they instruct and the assistant turn that answers it, which is also the
	* only position this protocol accepts them in — a change that would land
	* before any turn is a request the endpoint rejects, so it is refused here
	* with the reason instead.
	*/
	const flushUpdates = () => {
		if (updates.length === 0) return;
		if (out.at(-1)?.role !== "user") throw new LlmError("llm-service-lite: a mid-history system update has no preceding user turn to follow; this route declared systemPromptUpdate or toolUpdate, which needs one", "UNSUPPORTED_CONTENT");
		out.push({
			role: "system",
			content: updates
		});
		updates = [];
	};
	/**
	* The one exit for a call the durable log never answered: it is answered with
	* what it did produce, or with a placeholder. Registering the id here is what
	* makes a later real result a duplicate the repair drops rather than a second
	* result for one call.
	*/
	const answers = (ids) => {
		const parts = [];
		for (const id of ids) {
			if (answered.has(id)) continue;
			answered.add(id);
			parts.push(toolResultPart(id, outputs.get(id), versions));
		}
		return parts;
	};
	const flushBatch = () => {
		if (batch.length === 0) return;
		const content = [...batch, ...answers(pending)];
		batch = [];
		pending = [];
		out.push({
			role: "user",
			content
		});
	};
	const flushPending = () => {
		if (pending.length === 0) return;
		const content = answers(pending);
		pending = [];
		out.push({
			role: "user",
			content
		});
	};
	const leading = usesLeadingSystem$1(options);
	for (const [index, message] of messages.entries()) {
		if (leading && index === 0) continue;
		if (message.role === "tool") {
			const id = String(message.toolCallId);
			if (calls.has(id) && declared.has(id) && !answered.has(id)) {
				answered.add(id);
				batch.push(toolResultPart(id, outputs.get(id), versions));
			}
			if (messages[index + 1]?.role !== "tool") flushBatch();
			continue;
		}
		flushBatch();
		flushPending();
		if (inHistory && message.role !== "system" && message.role !== "developer" && message.content.some((block) => block.type === "tool-addition" || block.type === "tool-removal")) throw new LlmError(`llm-service-lite: a ${message.role} message carries a tool-addition or tool-removal block; both belong to developer messages, and this protocol has no part for them on another role`, "UNSUPPORTED_CONTENT");
		if (message.role === "user") {
			const content = userParts$1(message.content, versions);
			if (content.length > 0) out.push({
				role: "user",
				content
			});
			continue;
		}
		if (message.role === "system" || message.role === "developer") {
			if (inHistory && (message.role === "developer" || model.systemPromptUpdate === "in-history")) {
				updates.push(...systemParts(message));
				continue;
			}
			const text = textOf$2(message);
			if (text.length > 0) out.push({
				role: "user",
				content: [{
					type: "text",
					text
				}]
			});
			continue;
		}
		flushUpdates();
		const replayed = replayBlocksOf$1(message, provider, model.id);
		const content = [];
		for (const [position, block] of message.content.entries()) {
			if (block.type === "text") {
				if (block.text.length > 0) content.push({
					type: "text",
					text: block.text
				});
				continue;
			}
			if (block.type === "tool-call") {
				const id = String(block.id);
				if (declared.has(id)) continue;
				declared.add(id);
				pending.push(id);
				content.push({
					type: "tool_use",
					id,
					name: block.name,
					input: toolInput(block.arguments)
				});
				continue;
			}
			if (block.type === "reasoning") {
				const part = reasoningPart(block.text, replayed?.[position]);
				if (part !== void 0) content.push(part);
			}
		}
		if (content.length === 0) content.push({
			type: "text",
			text: TRIMMED_TURN_TEXT
		});
		out.push({
			role: "assistant",
			content
		});
	}
	flushBatch();
	flushPending();
	flushUpdates();
	return out;
}
/**
* The parts one mid-history message contributes when the route declared
* mid-history changes: prompt text as itself, and each tool change as the
* reference this protocol spells. Any other block is refused by name rather
* than dropped — a message the endpoint cannot read in full must not look like
* a request that carried it.
* @param message - developer or system message from the durable history.
* @returns the parts to queue, empty when the message carried nothing.
* @throws LlmError `UNSUPPORTED_CONTENT` naming a block this role cannot carry.
*/
function systemParts(message) {
	const parts = [];
	for (const block of message.content) {
		if (block.type === "text") {
			if (block.text.length > 0) parts.push({
				type: "text",
				text: block.text
			});
			continue;
		}
		if (block.type === "tool-addition") {
			parts.push({
				type: "tool_addition",
				tool: {
					type: "tool_reference",
					name: block.toolName
				}
			});
			continue;
		}
		if (block.type === "tool-removal") {
			parts.push({
				type: "tool_removal",
				tool: {
					type: "tool_reference",
					name: block.toolName
				}
			});
			continue;
		}
		throw new LlmError(`llm-service-lite: a mid-history system message carries a ${block.type} block, which this protocol reads only as prompt text or a tool reference`, "UNSUPPORTED_CONTENT");
	}
	return parts;
}
/**
* The effective output cap: the request's own, else the profile's override,
* else the model's configured default, else the cap its family documents.
* This protocol requires the field, so it is always sent — and a model no
* family speaks for falls back to the conservative unmatched default.
*/
function effectiveMaxTokens(profile, model, options) {
	if (options.maxTokens !== void 0) return options.maxTokens;
	const override = profile.extraBody["max_tokens"];
	if (typeof override === "number") return override;
	return model.defaults.maxTokens ?? anthropicMaxTokensOf(model.id);
}
/** Extended thinking's documented floor; a smaller budget is rejected outright. */
const MIN_THINKING_BUDGET = 1024;
/**
* Extended-thinking budget for the given output cap: thinking and answer share
* `max_tokens`, so the budget leaves the answer room — an eighth of the cap, at
* least the floor — instead of asking for a budget that leaves none. A cap too
* small for the floor asks for the largest budget below it, which the endpoint
* rejects by name rather than silently truncating the answer.
* @param maxTokens - effective output cap of this request.
* @returns the budget to declare.
*/
function extendedThinkingBudget(maxTokens) {
	const budget = maxTokens - Math.max(MIN_THINKING_BUDGET, Math.floor(maxTokens / 8));
	if (budget >= MIN_THINKING_BUDGET) return budget;
	return Math.min(MIN_THINKING_BUDGET, Math.max(1, maxTokens - 1));
}
/**
* The reasoning fields this request declares.
*
* The harness exposes one selector, so the level the caller picked decides
* both spellings: an effort level becomes `output_config.effort`, and a
* thinking mode becomes the `thinking` block. A model that declares efforts but
* no mode sends only the effort — the endpoint's own default then applies — and
* a request that selected nothing sends neither field, because a capability the
* profile did not declare is not one this adapter invents.
* @param model - the route's declared facts for this model.
* @param level - the wire meaning of the selected level.
* @param maxTokens - effective output cap, which bounds an extended budget.
* @returns fields to merge into the request body.
*/
function thinkingFields(model, level, maxTokens) {
	if (level.thinking !== true) return {};
	const mode = level.mode ?? (model.thinking.includes("adaptive") ? "adaptive" : model.thinking.includes("enabled") ? "enabled" : void 0);
	return {
		...level.effort === void 0 ? {} : { output_config: { effort: level.effort } },
		...mode === void 0 ? {} : { thinking: mode === "adaptive" ? {
			type: "adaptive",
			display: "summarized"
		} : {
			type: "enabled",
			budget_tokens: extendedThinkingBudget(maxTokens)
		} }
	};
}
/**
* Whether the leading system message supplies the prompt — which is also what
* removes it from the conversation, because this protocol reads its prompt in a
* top-level field rather than as a turn.
* @param options - the assembled request.
* @returns whether the first history message is that system message.
*/
function usesLeadingSystem$1(options) {
	if (options.system !== void 0 && options.system.length > 0) return false;
	return options.messages[0]?.role === "system";
}
/**
* The top-level `system` field: the request's own prompt, else the leading
* system message. Cache breakpoints are marked on it when the route declares
* prompt caching, which is what pins the stable prefix of every later request.
*/
function systemField(options, caching) {
	const [first] = options.messages;
	const text = usesLeadingSystem$1(options) && first !== void 0 ? textOf$2(first) : options.system;
	if (text === void 0 || text.length === 0) return {};
	if (!caching) return { system: text };
	return { system: [{
		type: "text",
		text,
		cache_control: { type: "ephemeral" }
	}] };
}
/**
* Assemble the HTTP request for one Messages call.
*
* @param profile - resolved route.
* @param model - the route's declared facts for this model.
* @param options - the assembled request.
* @param apiKey - resolved credential, when the route authenticates.
* @param versions - prepared request images, keyed by durable attachment id.
* @returns endpoint, headers, and serialized body.
*/
function anthropicRequest(profile, model, options, apiKey, versions = /* @__PURE__ */ new Map()) {
	const caching = profile.promptCaching;
	const level = reasoningLevelOf(model, reasoningLevelFor(model, options.reasoningEffort));
	const maxTokens = effectiveMaxTokens(profile, model, options);
	const tools = options.tools === void 0 || options.tools.length === 0 || !model.tools ? [] : options.tools;
	const temperature = options.temperature ?? model.defaults.temperature;
	const body = {
		...profile.extraBody,
		model: options.model,
		max_tokens: maxTokens,
		stream: true,
		...temperature === void 0 ? {} : { temperature },
		...model.defaults.topP === void 0 ? {} : { top_p: model.defaults.topP },
		...model.defaults.topK === void 0 ? {} : { top_k: model.defaults.topK },
		...options.stop === void 0 || options.stop.length === 0 ? {} : { stop_sequences: [...options.stop] },
		...systemField(options, caching),
		messages: toAnthropicMessages(options, profile.provider, model, versions),
		...thinkingFields(model, level, maxTokens),
		...tools.length === 0 ? {} : { tools: tools.map((tool, index) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
			...tool.deferLoading === true ? { defer_loading: true } : {},
			...caching && index === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}
		})) }
	};
	return {
		url: `${profile.baseURL.replace(/\/+$/u, "")}/messages`,
		headers: {
			...attributionHeaders(),
			"content-type": "application/json",
			accept: "text/event-stream",
			"anthropic-version": ANTHROPIC_VERSION$1,
			...profile.headers,
			...apiKey === void 0 || apiKey.length === 0 ? {} : {
				"x-api-key": apiKey,
				authorization: `Bearer ${apiKey}`
			}
		},
		body: JSON.stringify(body)
	};
}
//#endregion
//#region lib/types/errors.js
/**
* Provider-failure classification.
*
* OWC classifies a failure by HTTP status and provider error text before it
* decides whether to retry; the harness classifies by a stable error code and
* lets the agent's recovery layer decide. The translation keeps OWC's
* judgement about which failures are worth repeating and adds the two
* provider-neutral codes the harness can act on beyond retrying: an exhausted
* quota is terminal rather than a rate limit, and an oversized request is what
* triggers a forced compaction instead of a doomed retry.
*
* @module dsh-llm-service-lite/errors
*/
/** Response headers a provider uses to name a request across support tickets. */
const REQUEST_ID_HEADERS = [
	"request-id",
	"x-request-id",
	"x-deepseek-request-id"
];
/**
* Provider wordings the shared harness classifiers do not cover.
*
* The harness's `isContextWindowExceededError` deliberately matches the
* provider-neutral phrasings ("maximum context length", "too long for this
* model/context"). Anthropic spells the same condition as
* `prompt is too long: 208310 tokens > 200000 maximum` and its request
* byte-size limit as `request_too_large`; neither contains the word
* "context". The harness's own Anthropic-capable adapter recognises both
* (pi-ai `utils/overflow`), so missing them here would leave the compaction
* recovery path unreachable on a Messages route.
*/
const PROVIDER_CONTEXT_OVERFLOW = /prompt (?:is )?too long|request_too_large|input is too long for (?:the )?requested model/iu;
/** Anthropic spells an exhausted account balance this way; the shared quota patterns do not. */
const PROVIDER_QUOTA_EXHAUSTED = /credit balance is too low/iu;
/**
* Joined provider error code, type, and message text used by the classifiers.
* @param raw - the provider's error body or error object, as received.
* @returns the distinct non-empty text parts, joined by one space.
*/
function errorDetail(raw) {
	const envelope = typeof raw === "object" && raw !== null ? raw : {};
	const error = typeof envelope.error === "object" && envelope.error !== null ? envelope.error : envelope;
	const parts = [
		error.code,
		error.type,
		error.message,
		envelope.message
	].filter((value) => typeof value === "string" && value.length > 0);
	return [...new Set(parts)].join(" ");
}
/**
* Human-readable message from a provider error body, with a status-based fallback.
* @param raw - the provider's error body or error object, as received.
* @param status - HTTP status when the failure carried one.
* @returns the provider's own message, or a status-based diagnostic.
*/
function errorMessage(raw, status) {
	const envelope = typeof raw === "object" && raw !== null ? raw : {};
	const error = typeof envelope.error === "object" && envelope.error !== null ? envelope.error : envelope;
	if (typeof error.message === "string" && error.message.length > 0) return error.message;
	if (typeof envelope.message === "string" && envelope.message.length > 0) return envelope.message;
	return `llm-service-lite: provider request failed (${status === void 0 ? "stream error" : status})`;
}
/**
* Provider-requested retry delay, in milliseconds.
* `Retry-After` is either a delay in seconds or an HTTP date; both spellings
* appear in the wild, and a date already in the past yields no delay.
*/
function retryAfterMs(headers) {
	const value = headers?.get("retry-after");
	if (value === null || value === void 0) return void 0;
	const delay = /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) * 1e3 : Date.parse(value) - Date.now();
	return Number.isFinite(delay) && delay > 0 ? delay : void 0;
}
/** Provider request id when the response names one. */
function requestIdOf(headers) {
	for (const header of REQUEST_ID_HEADERS) {
		const value = headers?.get(header);
		if (value !== null && value !== void 0 && value.length > 0) return value;
	}
}
/** Structured provider facts every classified failure carries when the transport observed them. */
function providerFacts(status, headers) {
	const retryAfter = retryAfterMs(headers);
	const requestId = requestIdOf(headers);
	return {
		...status === void 0 ? {} : { status },
		...retryAfter === void 0 ? {} : { providerRetryAfterMs: retryAfter },
		...requestId === void 0 ? {} : { requestId: ProviderRequestId(requestId) }
	};
}
/**
* Classify one provider failure into the harness's stable error vocabulary.
*
* @param raw - decoded error body, or an in-band error event.
* @param status - HTTP status when the failure preceded streaming.
* @param headers - response headers, for `Retry-After` and the request id.
* @returns the classified failure, carrying any provider-requested delay.
*/
function classifyFailure(raw, status, headers) {
	const detail = errorDetail(raw);
	const message = errorMessage(raw, status);
	const facts = providerFacts(status, headers);
	if (status === 401 || status === 403) return new LlmError(message, "AUTH", facts);
	if (isQuotaExceededError(detail) || PROVIDER_QUOTA_EXHAUSTED.test(detail) || status === 402) return new LlmError(message, "QUOTA", facts);
	if (isContextWindowExceededError(detail) || PROVIDER_CONTEXT_OVERFLOW.test(detail)) return new LlmError(message, "CONTEXT_WINDOW_EXCEEDED", facts);
	if (status === 408 || status === 502 || status === 504) return new LlmError(message, "TRANSPORT", facts);
	if (status === 429) return new LlmError(message, "RATE_LIMIT", facts);
	if (status === 529 || status !== void 0 && status >= 500) return new LlmError(message, "SERVER", facts);
	if (status === 404 || status === 400 || status === 409 || status === 413 || status === 422) return new LlmError(message, "INVALID_REQUEST", facts);
	if (status !== void 0) return new LlmError(message, `HTTP_${status}`, facts);
	if (/rate[_-]?limit/iu.test(detail)) return new LlmError(message, "RATE_LIMIT", facts);
	if (/authentication|permission|unauthor/iu.test(detail)) return new LlmError(message, "AUTH", facts);
	if (/invalid[_-]?request/iu.test(detail)) return new LlmError(message, "INVALID_REQUEST", facts);
	return new LlmError(message, "SERVER", facts);
}
/**
* Classify a transport-level throw that never produced an HTTP status: the
* shapes OWC treats as retryable network failures, an upstream cancellation,
* and everything else as a failure the recovery layer will not repeat.
*
* @param error - the thrown value.
* @param aborted - the caller's own signal, to distinguish cancellation from failure.
* @returns the classified failure.
*/
function classifyTransport(error, aborted) {
	if (error instanceof LlmError) return error;
	if (aborted) return new LlmError("llm-service-lite: request aborted", "ABORTED", { cause: error });
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	return error instanceof TypeError || [
		"ECONNRESET",
		"ECONNREFUSED",
		"ETIMEDOUT",
		"EAI_AGAIN",
		"UND_ERR_SOCKET",
		"UND_ERR_CONNECT_TIMEOUT"
	].includes(code) ? new LlmError("llm-service-lite: provider transport failed", "TRANSPORT", { cause: error }) : new LlmError("llm-service-lite: provider request failed", "UNKNOWN", { cause: error });
}
//#endregion
//#region lib/types/anthropic-stream.js
/**
* Translation of one Messages event stream into the harness's chunk
* vocabulary.
*
* The provider streams an event protocol rather than a list of deltas: a
* content block opens with its identity and closes with an explicit stop, a
* tool call's arguments arrive as fragments of a JSON string, and the terminal
* events carry the stop reason and the token accounting. The translator owns
* three things the provider does not: block identity and ordering, tool-call
* assembly across fragments, and the difference between a stream that ended and
* one that was cut off.
*
* It also owns the replay metadata this protocol needs and the harness has no
* field for: signed thinking blocks must be returned unchanged on the next
* request, so their signatures ride along as adapter-private state on the
* assistant message and are read back by the request path.
*
* @module dsh-llm-service-lite/anthropic-stream
*/
/** A JSON object field, or an empty one when the provider sent something else. */
function asRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
/** The block index of a stream event, which every block-scoped event carries. */
function blockIndexOf(event) {
	const index = event["index"];
	if (typeof index !== "number" || !Number.isSafeInteger(index)) throw new LlmError("llm-service-lite: anthropic-messages stream event carries no block index", "MALFORMED_RESPONSE");
	return index;
}
/** One counter of a usage report; a present but unusable value is a malformed response, not a zero. */
function countOf$1(usage, field) {
	const value = usage[field];
	if (value === void 0) return void 0;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new LlmError(`llm-service-lite: anthropic-messages stream reported an invalid ${field}`, "MALFORMED_RESPONSE");
	return value;
}
/**
* Merge one usage report into the counters so far: this protocol reports input
* tokens when the message starts and the final output count when it ends, so
* each report contributes only the fields it carries.
* @param usage - the report's usage object.
* @param previous - counters from earlier reports.
* @returns the merged counters.
*/
function mergeUsage(usage, previous) {
	return {
		input: countOf$1(usage, "input_tokens") ?? previous?.input,
		output: countOf$1(usage, "output_tokens") ?? previous?.output,
		cacheRead: countOf$1(usage, "cache_read_input_tokens") ?? previous?.cacheRead,
		cacheWrite: countOf$1(usage, "cache_creation_input_tokens") ?? previous?.cacheWrite
	};
}
/**
* The harness's disjoint token accounting for one completed stream.
*
* This protocol's `input_tokens` counts uncached input only, with cache reads
* and cache writes reported beside it, which is exactly the harness's split; a
* report that never reached both counts is omitted rather than half-filled.
* @param counters - merged counters, when the stream reported any.
* @returns token usage, or undefined when the stream reported none.
*/
function usageOf$2(counters) {
	if (counters?.input === void 0 || counters.output === void 0) return void 0;
	const cacheRead = counters.cacheRead ?? 0;
	const cacheWrite = counters.cacheWrite ?? 0;
	return {
		inputTokens: counters.input,
		outputTokens: counters.output,
		totalTokens: counters.input + counters.output + cacheRead + cacheWrite,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite
	};
}
/**
* The harness finish reason for one provider stop reason.
*
* This protocol names more reasons than the harness has kinds, and a reason
* this build does not know is still a finished turn: the calls it made decide
* whether it stopped for them, which is what the harness routes on.
* @param stopReason - provider reason the stream reported.
* @param hasToolCalls - whether the response carried a tool call.
* @returns the finish reason.
*/
function finishReasonOf$2(stopReason, hasToolCalls) {
	if (stopReason === "tool_use") return { kind: "tool-calls" };
	if (stopReason === "max_tokens") return { kind: "max-tokens" };
	if (stopReason === "end_turn" || stopReason === "stop_sequence" || stopReason === "refusal" || stopReason === "pause_turn") return { kind: "stop" };
	return hasToolCalls ? { kind: "tool-calls" } : { kind: "stop" };
}
/** The assembled block one closed stream block contributes. */
function blockOf(block) {
	if (block.kind === "tool_use") return {
		type: "tool-call",
		id: ToolCallId(block.id),
		name: block.name,
		arguments: block.arguments
	};
	if (block.kind === "text") return {
		type: "text",
		text: block.text
	};
	return {
		type: "reasoning",
		text: block.kind === "redacted_thinking" ? "" : block.text
	};
}
/**
* Translate one Messages event stream into harness chunks.
*
* @param events - decoded JSON events in arrival order.
* @param sawSentinel - reports whether the transport delivered an end-of-stream
*   sentinel; a gateway may append one this protocol does not define, and the
*   stream's own `message_stop` is the terminal event either way.
* @returns the chunk stream, ending with exactly one terminal `finish`.
* @throws LlmError when the stream carries an in-band provider error, when it
*   was cut off, or when it ended without a stop reason.
*/
async function* translateAnthropicStream(events, sawSentinel) {
	const open = /* @__PURE__ */ new Map();
	const replay = [];
	let nextIndex = 0;
	let stopReason;
	let responseId;
	let sawMessageStop = false;
	let sawOutput = false;
	let counters;
	for await (const event of events) {
		const type = event["type"];
		if (type === "error") throw classifyFailure(event, void 0);
		if (type === "message_start") {
			const message = asRecord$1(event["message"]);
			const id = message["id"];
			if (typeof id === "string" && id.length > 0) responseId = id;
			const usage = message["usage"];
			if (usage !== void 0) counters = mergeUsage(asRecord$1(usage), counters);
			continue;
		}
		if (type === "content_block_start") {
			const block = asRecord$1(event["content_block"]);
			const kind = block["type"];
			if (kind !== "text" && kind !== "thinking" && kind !== "redacted_thinking" && kind !== "tool_use") continue;
			const id = typeof block["id"] === "string" ? block["id"] : "";
			if (kind === "tool_use" && id.length === 0) throw new LlmError("llm-service-lite: anthropic-messages stream opened a tool call without an id", "MALFORMED_RESPONSE");
			const initialText = typeof block["text"] === "string" ? block["text"] : "";
			const initialThinking = typeof block["thinking"] === "string" ? block["thinking"] : "";
			const initialInput = kind === "tool_use" ? asRecord$1(block["input"]) : {};
			const seedArguments = Object.keys(initialInput).length === 0 ? void 0 : JSON.stringify(initialInput);
			const opened = {
				index: nextIndex,
				kind,
				text: kind === "text" ? initialText : kind === "thinking" ? initialThinking : "",
				arguments: "",
				seedArguments,
				id,
				name: typeof block["name"] === "string" ? block["name"] : "",
				signature: typeof block["signature"] === "string" ? block["signature"] : "",
				data: typeof block["data"] === "string" ? block["data"] : ""
			};
			nextIndex += 1;
			open.set(blockIndexOf(event), opened);
			replay.push(kind === "tool_use" ? { type: "tool-call" } : kind === "text" ? { type: "text" } : { type: "reasoning" });
			yield {
				type: "block-start",
				index: opened.index,
				blockType: kind === "tool_use" ? "tool-call" : kind === "text" ? "text" : "reasoning"
			};
			if (kind !== "tool_use") {
				if (kind === "redacted_thinking") {
					sawOutput = true;
					continue;
				}
				if (opened.text.length > 0) {
					sawOutput = true;
					yield kind === "text" ? {
						type: "text-delta",
						index: opened.index,
						text: opened.text
					} : {
						type: "reasoning-delta",
						index: opened.index,
						text: opened.text
					};
				}
				continue;
			}
			sawOutput = true;
			yield {
				type: "tool-call-delta",
				index: opened.index,
				id: ToolCallId(opened.id),
				name: opened.name,
				argumentsDelta: ""
			};
			continue;
		}
		if (type === "content_block_delta") {
			const opened = open.get(blockIndexOf(event));
			const delta = asRecord$1(event["delta"]);
			const deltaType = delta["type"];
			if (opened === void 0) continue;
			if (deltaType === "signature_delta") {
				if (typeof delta["signature"] === "string") opened.signature += delta["signature"];
				continue;
			}
			if (opened.kind === "text" && deltaType === "text_delta" && typeof delta["text"] === "string" && delta["text"].length > 0) {
				sawOutput = true;
				opened.text += delta["text"];
				yield {
					type: "text-delta",
					index: opened.index,
					text: delta["text"]
				};
				continue;
			}
			if (opened.kind === "thinking" && deltaType === "thinking_delta" && typeof delta["thinking"] === "string" && delta["thinking"].length > 0) {
				sawOutput = true;
				opened.text += delta["thinking"];
				yield {
					type: "reasoning-delta",
					index: opened.index,
					text: delta["thinking"]
				};
				continue;
			}
			if (opened.kind === "tool_use" && deltaType === "input_json_delta" && typeof delta["partial_json"] === "string") {
				opened.arguments += delta["partial_json"];
				yield {
					type: "tool-call-delta",
					index: opened.index,
					id: ToolCallId(opened.id),
					argumentsDelta: delta["partial_json"]
				};
			}
			continue;
		}
		if (type === "content_block_stop") {
			const providerIndex = blockIndexOf(event);
			const opened = open.get(providerIndex);
			if (opened === void 0) continue;
			open.delete(providerIndex);
			if (opened.kind === "tool_use" && opened.arguments.length === 0) opened.arguments = opened.seedArguments ?? "{}";
			const entry = replay[opened.index];
			if (entry?.type === "reasoning" && opened.kind === "thinking" && opened.signature.length > 0) entry.signature = opened.signature;
			if (entry?.type === "reasoning" && opened.kind === "redacted_thinking") entry.redacted = opened.data;
			yield {
				type: "block-end",
				index: opened.index,
				block: blockOf(opened)
			};
			continue;
		}
		if (type === "message_delta") {
			const reason = asRecord$1(event["delta"])["stop_reason"];
			if (typeof reason === "string" && reason.length > 0) stopReason = reason;
			const usage = event["usage"];
			if (usage !== void 0) counters = mergeUsage(asRecord$1(usage), counters);
			continue;
		}
		if (type === "message_stop") {
			sawMessageStop = true;
			break;
		}
	}
	if (open.size > 0) throw new LlmError("llm-service-lite: anthropic-messages stream ended inside a content block", "TRANSPORT");
	if (!sawMessageStop && !sawSentinel()) throw new LlmError("llm-service-lite: anthropic-messages stream ended before a terminal event", "TRANSPORT");
	if (!sawOutput) throw new LlmError("llm-service-lite: anthropic-messages response carried no content", "EMPTY_RESPONSE");
	if (stopReason === void 0) throw new LlmError("llm-service-lite: anthropic-messages stream ended without a stop reason", "TRANSPORT");
	if (stopReason === "model_context_window_exceeded") throw new LlmError("llm-service-lite: anthropic-messages reported that the model context window was exceeded", CONTEXT_WINDOW_EXCEEDED_CODE);
	const finish = finishReasonOf$2(stopReason, replay.some((entry) => entry.type === "tool-call"));
	const usage = usageOf$2(counters);
	if (usage !== void 0) yield {
		type: "usage",
		usage
	};
	yield {
		type: "finish",
		reason: finish,
		replayState: {
			response: {
				kind: REPLAY_KIND,
				version: 1,
				stopReason,
				...responseId === void 0 ? {} : { responseId }
			},
			blocks: replay
		}
	};
}
//#endregion
//#region lib/types/image-output.js
/**
* Images an endpoint returns, carried back into the session.
*
* A model that generates or edits pictures answers with image content, and
* every wire spells it differently: the chat-completions protocol returns
* image parts beside the text, and the Responses protocol returns an
* image-generation item whose result is the encoded picture. A wire translator
* therefore emits {@link GeneratedImageChunk} — bytes and their declared media
* type, not yet durable — and the adapter commits them through the attachment
* provider and republishes them as the harness's own `block-end` image block,
* so the session stores a reference rather than base64 in the durable log.
*
* @module dsh-llm-service-lite/image-output
*/
/** Image media types this adapter carries from an endpoint back into a session. */
const OUTPUT_MEDIA_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
];
/** Whether one chunk is an image this adapter still has to commit. */
function isGeneratedImage(chunk) {
	return chunk.type === "generated-image";
}
/**
* Decode one image an endpoint returned inline.
*
* Only an inline `data:` URL is carried: the adapter never fetches a URL an
* endpoint names, because that fetch would leave the request path and the
* session would store a reference to content the deployment never received.
*
* @param url - the `url` of an image part the endpoint returned.
* @param at - brief description of where the image came from, for the diagnostic.
* @returns the decoded bytes and the media type they were declared as.
* @throws LlmError `UNSUPPORTED_CONTENT` when the URL is not an inline image this adapter carries.
*/
function decodeGeneratedImage(url, at) {
	const match = /^data:([^;,]+);base64,([\s\S]*)$/u.exec(url);
	const mediaType = match?.[1];
	if (match === null || mediaType === void 0) throw new LlmError(`llm-service-lite: ${at} returned an image as a URL this adapter does not fetch; only an inline data: URL is carried`, "UNSUPPORTED_CONTENT");
	if (!OUTPUT_MEDIA_TYPES.includes(mediaType)) throw new LlmError(`llm-service-lite: ${at} returned an image of type "${mediaType}", which this adapter does not carry; it carries ${OUTPUT_MEDIA_TYPES.join(", ")}`, "UNSUPPORTED_CONTENT");
	return encodedImage(match[2] ?? "", at);
}
/**
* Read encoded bytes as one durable image.
*
* The bytes decide: an endpoint's own declaration is a hint, and the
* attachment provider validates the stored payload against the type it is
* saved as.
*
* @param base64 - encoded image payload, without its data-URL prefix.
* @param at - brief description of where the image came from, for the diagnostic.
* @returns the decoded bytes and the media type the bytes themselves state.
* @throws LlmError `UNSUPPORTED_CONTENT` when the payload is not an image this adapter carries.
*/
function encodedImage(base64, at) {
	const data = new Uint8Array(Buffer.from(base64, "base64"));
	const sniffed = sniffImageMediaType(data);
	if (sniffed === void 0) throw new LlmError(`llm-service-lite: ${at} returned image bytes that are not ${OUTPUT_MEDIA_TYPES.join(", ")}; this adapter carries those four raster types`, "UNSUPPORTED_CONTENT");
	return {
		mediaType: sniffed,
		data
	};
}
/**
* The raster type a byte payload states through its magic bytes.
* @param data - encoded image bytes.
* @returns the media type, or undefined when the bytes name none of them.
*/
function sniffImageMediaType(data) {
	const ascii = (offset, text) => {
		for (let index = 0; index < text.length; index += 1) if (data[offset + index] !== text.charCodeAt(index)) return false;
		return true;
	};
	if (data[0] === 137 && ascii(1, "PNG")) return "image/png";
	if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
	if (ascii(0, "GIF8")) return "image/gif";
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
}
/**
* The durable image block one committed attachment becomes.
* @param attachment - the reference the attachment provider returned.
* @returns the block the harness session stores.
*/
function generatedImageBlock(attachment) {
	return {
		type: "image",
		attachment
	};
}
//#endregion
//#region lib/types/chat-completions.js
/**
* The `openai-chat-completions` wire: request assembly and stream translation.
*
* The request body follows OWC's field order and its two deliberate silences:
* `max_tokens` is sent only when a request configured one, and the thinking
* switch is sent only for a model whose catalog declares how this endpoint
* spells it. Everything else about the endpoint — its extra body fields, its
* usage report, its reasoning dialect — is a profile declaration, so a gateway
* reaches the same path as a first-party endpoint with no code change.
*
* The translator reconstructs the harness's block stream from the provider's
* delta stream, which means it owns three things the provider does not: block
* identity and ordering, tool-call assembly across fragments, and the
* distinction between a stream that ended and one that was cut off.
*
* @module dsh-llm-service-lite/chat-completions
*/
/** The image URLs one choice states, from the delta or a whole message. */
function imageUrls(choice) {
	const urls = [];
	for (const container of [choice.delta, choice.message]) {
		if (!Array.isArray(container?.images)) continue;
		for (const part of container.images) {
			const url = part?.image_url?.url;
			if (typeof url === "string") urls.push(url);
		}
	}
	return urls;
}
/** Concatenated text of the blocks a message role contributes as text. */
function textOf$1(message) {
	return message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
}
/**
* The thinking switch OWC's catalog declares for this endpoint, if it has one.
* A model that declares no style sends only its effort level, which is what
* lets an OpenAI-compatible gateway with an unusual dialect take the same code
* path as a first-party endpoint.
*/
function thinkingSwitch(model, thinking) {
	if (model.thinkingStyle === void 0 || model.thinkingStyle === "effort_only" || thinking === void 0) return {};
	if (model.thinkingStyle === "enable_thinking") return { enable_thinking: thinking };
	return { thinking: { type: thinking ? "enabled" : "disabled" } };
}
/**
* Replay rules for tool calls, mirroring OWC's pairing repair.
*
* A chat-completions endpoint rejects a request whose `tool_calls` have no
* matching tool message, and rejects a tool message whose call it never saw.
* A durable history after an interrupted turn can contain both shapes, so the
* translation pairs what it can, drops orphan results, and answers a call
* whose result never landed with a placeholder.
*/
function toolPairings(messages) {
	const results = /* @__PURE__ */ new Map();
	for (const message of messages) {
		if (message.role !== "tool") continue;
		results.set(String(message.toolCallId), {
			text: textOf$1(message),
			isError: message.isError === true,
			media: message.content.flatMap((block) => block.type === "image" ? [block] : [])
		});
	}
	return { results };
}
/** The text envelope one synthetic media turn leads with, matching this plugin's other wires. */
const TOOL_MEDIA_NOTE = "Attached media from tool result:";
/**
* The one user turn that carries the media a batch of tool results produced.
* This protocol's tool message holds text only, so the pictures follow the
* batch; without this the model is told it read an image it never receives.
* @param media - image occurrences the batch's results carried, in call order.
* @param versions - prepared request image versions, keyed by durable attachment id.
* @returns the user message, or undefined when the batch carried no media.
* @throws LlmError `INVALID_CONFIG` when a retained occurrence has no prepared version.
*/
function toolMediaMessage(media, versions) {
	if (media.length === 0) return void 0;
	const parts = [{
		type: "text",
		text: TOOL_MEDIA_NOTE
	}];
	for (const block of media) {
		if (block.offloaded === true) {
			parts.push({
				type: "text",
				text: offloadedImageText$1(block)
			});
			continue;
		}
		const version = versions.get(block.attachment.attachmentId);
		if (version === void 0) throw new LlmError("llm-service-lite: a retained image occurrence reached the wire without a prepared request version", "INVALID_CONFIG");
		parts.push({
			type: "image_url",
			image_url: { url: imageDataUrl(version) }
		});
	}
	return {
		role: "user",
		content: parts
	};
}
/**
* Translate the durable history into chat-completions messages.
*
* @param options - the assembled request.
* @param model - the route's declared facts for this model.
* @param versions - prepared request images, keyed by durable attachment id.
* @returns protocol messages in conversation order.
*/
function toWireMessages(options, model, versions) {
	const messages = options.messages;
	const { results } = toolPairings(messages);
	const emittedCalls = /* @__PURE__ */ new Set();
	const out = [];
	if (options.system !== void 0 && options.system.length > 0) out.push({
		role: "system",
		content: options.system
	});
	for (const message of messages) switch (message.role) {
		case "system":
		case "developer": {
			const text = textOf$1(message);
			if (text.length > 0) out.push({
				role: "system",
				content: text
			});
			break;
		}
		case "user": {
			const parts = message.content.flatMap((block) => {
				if (block.type === "text") return block.text.length > 0 ? [{
					type: "text",
					text: block.text
				}] : [];
				if (block.type !== "image") return [];
				if (block.offloaded === true) return [{
					type: "text",
					text: offloadedImageText$1(block)
				}];
				const version = versions.get(block.attachment.attachmentId);
				if (version === void 0) throw new LlmError("llm-service-lite: a retained image occurrence reached the wire without a prepared request version", "INVALID_CONFIG");
				return [{
					type: "image_url",
					image_url: { url: imageDataUrl(version) }
				}];
			});
			if (parts.length === 0) break;
			const text = parts.map((part) => part.type === "text" ? part.text : "").join("");
			out.push({
				role: "user",
				content: parts.every((part) => part.type === "text") ? text : parts
			});
			break;
		}
		case "assistant": {
			const declared = /* @__PURE__ */ new Set();
			const calls = message.content.flatMap((block) => {
				if (block.type !== "tool-call") return [];
				const id = String(block.id);
				if (emittedCalls.has(id) || declared.has(id)) return [];
				declared.add(id);
				return [block];
			});
			const replay = replaysReasoning(model) && message.source.provider === options.provider;
			const reasoning = message.content.flatMap((block) => block.type === "reasoning" ? [block.text] : []).join("\n");
			const text = textOf$1(message);
			if (text.length === 0 && calls.length === 0 && !(replay && reasoning.length > 0)) break;
			const wire = {
				role: "assistant",
				content: text.length > 0 ? text : calls.length > 0 ? null : "",
				...calls.length === 0 ? {} : { tool_calls: calls.map((block) => ({
					id: String(block.id),
					type: "function",
					function: {
						name: block.name,
						arguments: block.arguments
					}
				})) },
				...replay && reasoning.length > 0 ? { reasoning_content: reasoning } : {}
			};
			out.push(wire);
			const media = [];
			for (const call of calls) {
				emittedCalls.add(String(call.id));
				const result = results.get(String(call.id));
				out.push({
					role: "tool",
					tool_call_id: String(call.id),
					content: result?.text ?? "Tool result missing: this call did not complete."
				});
				media.push(...result?.media ?? []);
			}
			const attached = toolMediaMessage(media, versions);
			if (attached !== void 0) out.push(attached);
			break;
		}
	}
	return out;
}
/**
* Assemble the HTTP request for one chat-completions call.
*
* @param profile - resolved route.
* @param model - the route's declared facts for this model.
* @param options - the assembled request.
* @param apiKey - resolved credential, when the route authenticates.
* @param versions - prepared request images, keyed by durable attachment id.
* @returns endpoint, headers, and serialized body.
*/
function chatRequest(profile, model, options, apiKey, versions = /* @__PURE__ */ new Map()) {
	const level = reasoningLevelOf(model, reasoningLevelFor(model, options.reasoningEffort));
	const messages = toWireMessages(options, model, versions);
	const temperature = options.temperature ?? model.defaults.temperature;
	const body = {
		...profile.extraBody,
		model: options.model,
		stream: true,
		...profile.includeUsage ? { stream_options: { include_usage: true } } : {},
		...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens },
		...temperature === void 0 ? {} : { temperature },
		...model.defaults.topP === void 0 ? {} : { top_p: model.defaults.topP },
		...model.defaults.topK === void 0 ? {} : { top_k: model.defaults.topK },
		...level.effort === void 0 ? {} : { reasoning_effort: level.effort },
		...thinkingSwitch(model, level.thinking),
		messages
	};
	if (model.tools && options.tools !== void 0 && options.tools.length > 0) body.tools = options.tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
	if (options.stop !== void 0 && options.stop.length > 0) body.stop = [...options.stop];
	return {
		url: `${profile.baseURL.replace(/\/+$/u, "")}/chat/completions`,
		headers: {
			...attributionHeaders(),
			"content-type": "application/json",
			accept: "text/event-stream",
			...profile.headers,
			...apiKey === void 0 || apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` }
		},
		body: JSON.stringify(body)
	};
}
/**
* Map the provider's finish reason onto the harness vocabulary.
*
* A stream that closed without a terminal reason is only a clean stop when it
* both delivered its sentinel and produced output; otherwise it was cut off
* mid-turn, which the caller must treat as a transport failure rather than as
* a completed message.
*/
function finishReasonOf$1(reason, sawDone, sawOutput, hasToolCalls) {
	if (reason === "tool_calls" || reason === "function_call") return { kind: "tool-calls" };
	if (reason === "length") return { kind: "max-tokens" };
	if (reason === "content_filter") return { kind: "stop" };
	if (reason === "stop") return { kind: "stop" };
	if (sawDone && sawOutput) return hasToolCalls ? { kind: "tool-calls" } : { kind: "stop" };
}
/** Validated token accounting from one provider usage report. */
function usageOf$1(chunk) {
	const usage = chunk.usage;
	if (usage === void 0 || typeof usage.prompt_tokens !== "number" || typeof usage.completion_tokens !== "number") return;
	const prompt = usage.prompt_tokens;
	const completion = usage.completion_tokens;
	if (!Number.isSafeInteger(prompt) || prompt < 0 || !Number.isSafeInteger(completion) || completion < 0) throw new LlmError("llm-service-lite: provider returned invalid token usage", "MALFORMED_RESPONSE");
	const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
	if (!Number.isSafeInteger(cached) || cached < 0 || cached > prompt) throw new LlmError("llm-service-lite: provider returned invalid cached token usage", "MALFORMED_RESPONSE");
	return {
		inputTokens: prompt - cached,
		outputTokens: completion,
		totalTokens: prompt + completion,
		cacheReadTokens: cached,
		cacheWriteTokens: 0
	};
}
/**
* Translate one chat-completions event stream into harness chunks.
*
* @param events - decoded JSON events in arrival order.
* @param sawDone - reports whether the stream delivered its sentinel.
* @returns the chunk stream, ending with exactly one terminal `finish`.
* @throws LlmError when the stream carries an in-band provider error, or when it was cut off.
*/
async function* translateChatStream(events, sawDone) {
	const open = /* @__PURE__ */ new Map();
	const tools = /* @__PURE__ */ new Map();
	let nextIndex = 0;
	let stopReason;
	let sawOutput = false;
	let pendingUsage;
	const startBlock = (kind) => {
		const block = {
			index: nextIndex,
			text: ""
		};
		nextIndex += 1;
		open.set(kind, block);
		return block;
	};
	const closeBlock = (kind) => {
		const block = open.get(kind);
		if (block === void 0) return void 0;
		open.delete(kind);
		const content = kind === "text" ? {
			type: "text",
			text: block.text
		} : {
			type: "reasoning",
			text: block.text
		};
		return {
			type: "block-end",
			index: block.index,
			block: content
		};
	};
	/** Chunks that end whichever block is open before a different kind begins. */
	const endOpenBlocks = () => {
		const closing = [];
		for (const kind of ["text", "reasoning"]) {
			const end = closeBlock(kind);
			if (end !== void 0) closing.push(end);
		}
		return closing;
	};
	for await (const raw of events) {
		if (raw.error !== void 0) throw classifyFailure(raw, void 0);
		const chunk = raw;
		const usage = usageOf$1(chunk);
		if (usage !== void 0) pendingUsage = usage;
		for (const choice of chunk.choices ?? []) {
			if (typeof choice.finish_reason === "string") stopReason = choice.finish_reason;
			for (const url of imageUrls(choice)) {
				for (const end of endOpenBlocks()) yield end;
				const index = nextIndex;
				nextIndex += 1;
				const image = decodeGeneratedImage(url, "the chat-completions endpoint");
				sawOutput = true;
				yield {
					type: "block-start",
					index,
					blockType: "image"
				};
				yield {
					type: "generated-image",
					index,
					...image
				};
			}
			const delta = choice.delta;
			if (delta === void 0) continue;
			if (typeof delta.content === "string" && delta.content.length > 0) {
				sawOutput = true;
				if (!open.has("text")) for (const end of endOpenBlocks()) yield end;
				const block = open.get("text") ?? startBlock("text");
				if (block.text.length === 0) yield {
					type: "block-start",
					index: block.index,
					blockType: "text"
				};
				block.text += delta.content;
				yield {
					type: "text-delta",
					index: block.index,
					text: delta.content
				};
			}
			if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
				sawOutput = true;
				if (!open.has("reasoning")) for (const end of endOpenBlocks()) yield end;
				const block = open.get("reasoning") ?? startBlock("reasoning");
				if (block.text.length === 0) yield {
					type: "block-start",
					index: block.index,
					blockType: "reasoning"
				};
				block.text += delta.reasoning_content;
				yield {
					type: "reasoning-delta",
					index: block.index,
					text: delta.reasoning_content
				};
			}
			for (const call of delta.tool_calls ?? []) {
				const key = typeof call.index === "number" ? call.index : tools.size;
				const current = tools.get(key) ?? {
					id: "",
					name: "",
					arguments: "",
					index: -1
				};
				if (typeof call.id === "string" && call.id.length > 0) current.id = call.id;
				if (typeof call.function?.name === "string") current.name += call.function.name;
				const fragment = typeof call.function?.arguments === "string" ? call.function.arguments : "";
				current.arguments += fragment;
				tools.set(key, current);
				if (current.id.length === 0) continue;
				sawOutput = true;
				if (current.index < 0) {
					current.index = nextIndex;
					nextIndex += 1;
					for (const end of endOpenBlocks()) yield end;
					yield {
						type: "block-start",
						index: current.index,
						blockType: "tool-call"
					};
					yield {
						type: "tool-call-delta",
						index: current.index,
						id: ToolCallId(current.id),
						...current.name.length === 0 ? {} : { name: current.name },
						argumentsDelta: current.arguments
					};
					continue;
				}
				yield {
					type: "tool-call-delta",
					index: current.index,
					id: ToolCallId(current.id),
					argumentsDelta: fragment
				};
			}
		}
	}
	const textEnd = closeBlock("text");
	if (textEnd !== void 0) yield textEnd;
	const reasoningEnd = closeBlock("reasoning");
	if (reasoningEnd !== void 0) yield reasoningEnd;
	const calls = [...tools.values()].filter((call) => call.index >= 0).sort((left, right) => left.index - right.index);
	for (const call of calls) yield {
		type: "block-end",
		index: call.index,
		block: {
			type: "tool-call",
			id: ToolCallId(call.id),
			name: call.name,
			arguments: call.arguments
		}
	};
	const hasToolCalls = calls.length > 0;
	const finish = finishReasonOf$1(stopReason, sawDone(), sawOutput, hasToolCalls);
	if (!sawOutput) {
		if (!sawDone() && stopReason === void 0) throw new LlmError("llm-service-lite: chat-completions stream ended before a terminal event", "TRANSPORT");
		throw new LlmError("llm-service-lite: chat-completions response carried no content", "EMPTY_RESPONSE");
	}
	if (finish === void 0) throw new LlmError("llm-service-lite: chat-completions stream ended before a terminal event", "TRANSPORT");
	if (pendingUsage !== void 0) yield {
		type: "usage",
		usage: pendingUsage
	};
	yield {
		type: "finish",
		reason: finish
	};
}
//#endregion
//#region lib/types/openai-responses.js
/**
* The `openai-responses` wire: request assembly and the input mapping every
* durable history needs before it crosses this protocol.
*
* The Responses API does not take a conversation of roles but a flat list of
* *items*: an assistant turn is a `message` item, a call is a `function_call`
* item, its result is a `function_call_output` item carrying the same
* `call_id`, and reasoning is its own item that must precede the message it
* belongs to. That vocabulary has its own pairing rules and its own failure
* modes — a call whose output is missing, a duplicated call, or an output no
* call ever declared — and a durable session can hold all of them after an
* interrupted turn. The mapping therefore repairs the input the way this
* plugin's other transports repair theirs, with one difference the protocol
* forces: a call nothing answered is *dropped* rather than answered with a
* placeholder, because this API validates that every `function_call` has an
* output and strict gateways reject a fabricated one. Parallel calls are
* grouped — every `function_call` of a turn, then every output — because the
* API folds consecutive items into the assistant turn they belong to, and
* interleaving pairs would split one turn into several.
*
* Reasoning replay follows the model's declaration: `reasoningContent` replays
* the thinking text as `reasoning_text` parts, and `responsesEncryptedReplay`
* replays the provider's own reasoning item verbatim — id and encrypted
* payload included, which is what lets a stateless request resume a turn whose
* reasoning the provider refuses to accept as plain text.
*
* @module dsh-llm-service-lite/openai-responses
*/
/** This API rejects an output cap below this value. */
const MIN_OUTPUT_TOKENS = 16;
/** Replay-metadata kinds this transport writes and reads. */
const RESPONSES_REPLAY_KIND = "llm-service-lite-responses";
/** Joined text of the blocks a message contributes as text. */
function textOf(message) {
	return message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
}
/**
* The replay metadata of one assistant message, when this route may use it.
*
* Every mismatch degrades the message to provider-neutral input instead of
* failing the request: another adapter's metadata means nothing here, another
* version cannot be read, and an envelope that no longer aligns with the
* content cannot be trusted. A degraded turn still carries its text and its
* calls; it loses the reasoning the provider would have accepted back.
*
* @param message - durable assistant message with optional adapter-private replay metadata.
* @param provider - route this request is addressed to.
* @param model - exact model this request is addressed to.
* @returns one entry per durable content block, or undefined when none applies.
*/
function replayBlocksOf(message, provider, model) {
	const source = message.source;
	if (source.provider !== provider || source.model !== model) return void 0;
	const envelope = source.replayState;
	if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return void 0;
	const record = envelope;
	const response = record["response"];
	if (typeof response !== "object" || response === null || Array.isArray(response)) return void 0;
	const facts = response;
	if (facts["kind"] !== "llm-service-lite-responses" || facts["version"] !== 1) return void 0;
	const blocks = record["blocks"];
	if (!Array.isArray(blocks) || blocks.length !== message.content.length) return void 0;
	const entries = blocks;
	for (const [position, block] of message.content.entries()) {
		const entry = entries[position];
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return void 0;
		const replay = entry;
		if (replay["type"] !== block.type) return void 0;
		for (const field of ["itemId", "item"]) {
			const value = replay[field];
			if (value !== void 0 && typeof value !== "string") return void 0;
		}
	}
	return entries;
}
/**
* Read the calls and the results of one history.
* @param messages - complete request inputs.
* @returns the first result per call id, and every declared call id.
*/
function scanPairings(messages) {
	const outputs = /* @__PURE__ */ new Map();
	const calls = /* @__PURE__ */ new Set();
	for (const message of messages) {
		if (message.role === "tool") {
			const id = String(message.toolCallId);
			if (outputs.has(id)) continue;
			outputs.set(id, {
				text: textOf(message),
				media: message.content.flatMap((block) => block.type === "image" ? [block] : [])
			});
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "tool-call") calls.add(String(block.id));
	}
	return {
		outputs,
		calls
	};
}
/**
* One image occurrence as an input part: its bytes, or the placeholder text an
* offloaded occurrence left in its place.
* @param block - durable image occurrence.
* @param versions - prepared request versions, keyed by durable attachment id.
* @returns the protocol part.
* @throws LlmError `INVALID_CONFIG` when a retained occurrence has no prepared version.
*/
function imagePart(block, versions) {
	if (block.offloaded === true) return {
		type: "input_text",
		text: offloadedImageText$1(block)
	};
	const version = versions.get(block.attachment.attachmentId);
	if (version === void 0) throw new LlmError("llm-service-lite: a retained image occurrence reached the wire without a prepared request version", "INVALID_CONFIG");
	const data = Buffer.from(version.data).toString("base64");
	return {
		type: "input_image",
		detail: "auto",
		image_url: `data:${version.mediaType};base64,${data}`
	};
}
/** One user turn's parts, with every image resolved and unknown blocks skipped. */
function userParts(content, versions) {
	const parts = [];
	for (const block of content) {
		if (block.type === "text") {
			if (block.text.length > 0) parts.push({
				type: "input_text",
				text: block.text
			});
			continue;
		}
		if (block.type === "image") parts.push(imagePart(block, versions));
	}
	return parts;
}
/**
* The item that answers one batch: a synthesized user turn carrying the media
* the batch's results produced. Tool results cannot hold images here, and this
* API pairs calls with their outputs by id, so the media follows the outputs
* as one user item.
*/
function mediaItem(media, versions) {
	if (media.length === 0) return void 0;
	return {
		type: "message",
		role: "user",
		content: [{
			type: "input_text",
			text: "Attached media from tool result:"
		}, ...media.map((block) => imagePart(block, versions))]
	};
}
/** One reasoning item replayed as plain text, in the shape a thinking-mode endpoint expects. */
function reasoningTextItem(text) {
	return {
		type: "reasoning",
		content: [{
			type: "reasoning_text",
			text
		}]
	};
}
/**
* The provider's own reasoning item, when this route may replay it verbatim.
* Only a model that declares encrypted replay may send it back, and only an
* item this transport wrote is trusted: the payload is opaque, so any
* malformation degrades the one block rather than failing the request.
* @param entry - the block's replay metadata.
* @returns the item, or undefined when it cannot be replayed.
*/
function encryptedReasoningItem(entry) {
	if (entry === void 0 || entry.type !== "reasoning" || entry.item === void 0) return void 0;
	try {
		const parsed = JSON.parse(entry.item);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && parsed["type"] === "reasoning") return parsed;
	} catch (_malformedReplayItem) {}
}
/** The reasoning pre-items one assistant turn contributes, in block order. */
function reasoningItems(message, replayed, plainText, encrypted, sameSource) {
	const items = [];
	for (const [position, block] of message.content.entries()) {
		if (block.type !== "reasoning") continue;
		const entry = replayed?.[position];
		if (encrypted) {
			const verbatim = encryptedReasoningItem(entry);
			if (verbatim !== void 0) {
				items.push(verbatim);
				continue;
			}
		}
		if (plainText && sameSource && block.text.length > 0) items.push(reasoningTextItem(block.text));
	}
	return items;
}
/**
* Translate the durable history into Responses input items.
*
* @param options - the assembled request.
* @param provider - route this request is addressed to, for replay matching.
* @param model - the route's declared facts for this model.
* @param versions - prepared request images, keyed by durable attachment id.
* @returns protocol input items in conversation order.
*/
function toResponsesInput(options, provider, model, versions) {
	const messages = options.messages;
	const { outputs } = scanPairings(messages);
	const declared = /* @__PURE__ */ new Set();
	const out = [];
	const leading = usesLeadingSystem(options);
	for (const [index, message] of messages.entries()) {
		if (leading && index === 0) continue;
		if (message.role === "user") {
			const content = userParts(message.content, versions);
			if (content.length > 0) out.push({
				type: "message",
				role: "user",
				content
			});
			continue;
		}
		if (message.role === "system" || message.role === "developer") {
			const text = textOf(message);
			if (text.length > 0) out.push({
				type: "message",
				role: "user",
				content: [{
					type: "input_text",
					text
				}]
			});
			continue;
		}
		if (message.role === "tool") continue;
		const replayed = replayBlocksOf(message, provider, model.id);
		const sameSource = message.source.provider === provider && message.source.model === model.id;
		out.push(...reasoningItems(message, replayed, model.reasoningContent, model.encryptedReplay, sameSource));
		const text = textOf(message);
		if (text.length > 0) {
			const itemId = replayed?.find((entry) => entry.type === "text")?.itemId;
			out.push({
				type: "message",
				role: "assistant",
				content: [{
					type: "output_text",
					text,
					annotations: []
				}],
				...itemId === void 0 ? {} : { id: itemId }
			});
		}
		const calls = [];
		for (const [position, block] of message.content.entries()) {
			if (block.type !== "tool-call") continue;
			const id = String(block.id);
			const output = outputs.get(id);
			if (output === void 0 || declared.has(id)) continue;
			declared.add(id);
			const itemId = replayed?.[position]?.type === "tool-call" ? replayed[position].itemId : void 0;
			calls.push({
				call: {
					type: "function_call",
					call_id: id,
					name: block.name,
					arguments: block.arguments,
					...itemId === void 0 ? {} : { id: itemId }
				},
				output
			});
		}
		out.push(...calls.map((entry) => entry.call));
		const media = [];
		for (const entry of calls) {
			out.push({
				type: "function_call_output",
				call_id: entry.call.call_id,
				output: entry.output.text
			});
			media.push(...entry.output.media);
		}
		const attached = mediaItem(media, versions);
		if (attached !== void 0) out.push(attached);
	}
	return out;
}
/**
* Whether the leading system message supplies the instructions — which is also
* what removes it from the input, because this protocol reads instructions in a
* top-level field rather than as an item.
* @param options - the assembled request.
* @returns whether the first history message is that system message.
*/
function usesLeadingSystem(options) {
	if (options.system !== void 0 && options.system.length > 0) return false;
	return options.messages[0]?.role === "system";
}
/** The instructions field: the request's own prompt, else the leading system message. */
function instructionsOf(options) {
	const [first] = options.messages;
	const text = usesLeadingSystem(options) && first !== void 0 ? textOf(first) : options.system;
	return text === void 0 || text.length === 0 ? void 0 : text;
}
/**
* The reasoning fields this request declares, and whether the encrypted-replay
* include belongs with them.
*
* This protocol spells reasoning as an effort and a summary request; it has no
* switch for turning thinking on, so a mode-only selection sends nothing and
* the endpoint's own default applies. Disabling thinking is expressible for a
* model whose profile declares a switch this protocol can spell.
* @param model - the route's declared facts for this model.
* @param level - the wire meaning of the selected level.
* @returns fields to merge into the body, and whether the request asks for encrypted reasoning.
*/
function reasoningFields(model, level) {
	if (level.thinking === false) return {
		...model.thinkingStyle === "thinking" || model.thinkingStyle === "fixed" ? { reasoning: { effort: "none" } } : {},
		includeEncrypted: false
	};
	if (level.effort === void 0) return { includeEncrypted: false };
	return {
		reasoning: {
			effort: level.effort,
			summary: "auto"
		},
		includeEncrypted: model.encryptedReplay
	};
}
/**
* Assemble the HTTP request for one Responses call.
*
* @param profile - resolved route.
* @param model - the route's declared facts for this model.
* @param options - the assembled request.
* @param apiKey - resolved credential, when the route authenticates.
* @param versions - prepared request images, keyed by durable attachment id.
* @returns endpoint, headers, and serialized body.
*/
function responsesRequest(profile, model, options, apiKey, versions = /* @__PURE__ */ new Map()) {
	const level = reasoningLevelOf(model, reasoningLevelFor(model, options.reasoningEffort));
	const reasoning = reasoningFields(model, level);
	const maxTokens = options.maxTokens ?? model.defaults.maxTokens ?? model.maxTokens;
	const tools = options.tools === void 0 || options.tools.length === 0 || !model.tools ? [] : options.tools;
	const temperature = options.temperature ?? model.defaults.temperature;
	const topP = model.defaults.topP;
	const body = {
		...profile.extraBody,
		model: options.model,
		stream: true,
		...instructionsOf(options) === void 0 ? {} : { instructions: instructionsOf(options) },
		input: toResponsesInput(options, profile.provider, model, versions),
		max_output_tokens: Math.max(maxTokens, MIN_OUTPUT_TOKENS),
		...level.effort === void 0 && temperature !== void 0 ? { temperature } : {},
		...level.effort === void 0 && topP !== void 0 ? { top_p: topP } : {},
		...tools.length === 0 ? {} : { tools: tools.map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		})) },
		...reasoning.reasoning === void 0 ? {} : { reasoning: reasoning.reasoning },
		...reasoning.includeEncrypted ? { include: ["reasoning.encrypted_content"] } : {}
	};
	return {
		url: `${profile.baseURL.replace(/\/+$/u, "")}/responses`,
		headers: {
			...attributionHeaders(),
			"content-type": "application/json",
			accept: "text/event-stream",
			...profile.headers,
			...apiKey === void 0 || apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` }
		},
		body: JSON.stringify(body)
	};
}
//#endregion
//#region lib/types/responses-stream.js
/**
* Translation of one Responses event stream into the harness's chunk
* vocabulary.
*
* This protocol streams the *items* it is building rather than a sequence of
* deltas: `response.output_item.added` names an item, `done` closes it with the
* authoritative copy, and the deltas in between are fragments of it. The
* translator therefore owns block identity and ordering, tool-call assembly
* across argument fragments, and the difference between a stream that ended and
* one that was cut off, exactly as this adapter's other transports do — with
* one addition this protocol needs: the item that closes a block also carries
* the identity a later request must hand back (`msg_`/`rs_`/`fc_` id, and the
* encrypted reasoning payload), so it is written into the adapter-private
* replay metadata as the block closes.
*
* A provider that streams nothing but its terminal event is still served: the
* authoritative output it carries is written as a block of its own, so a
* non-streaming endpoint produces the same message as a streaming one.
*
* @module dsh-llm-service-lite/responses-stream
*/
/** A JSON object field, or an empty one when the provider sent something else. */
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
/** A JSON array field, or an empty one when the provider sent something else. */
function asArray(value) {
	return Array.isArray(value) ? value : [];
}
/** A text field, or nothing when the provider sent something else. */
function asText(value) {
	return typeof value === "string" ? value : void 0;
}
/** The authoritative text of one assistant message item: `output_text` parts plus a refusal. */
function messageItemText(item) {
	return asArray(item["content"]).flatMap((part) => {
		const record = asRecord(part);
		const type = record["type"];
		if (type === "output_text") return [asText(record["text"]) ?? ""];
		if (type === "refusal") return [asText(record["refusal"]) ?? ""];
		return [];
	}).join("");
}
/** The authoritative text of one reasoning item: its summary, else its plain-text reasoning. */
function reasoningItemText(item) {
	const summary = asArray(item["summary"]).flatMap((part) => [asText(asRecord(part)["text"]) ?? ""]);
	if (summary.length > 0) return summary.join("\n\n");
	return asArray(item["content"]).flatMap((part) => {
		const record = asRecord(part);
		return record["type"] === "reasoning_text" ? [asText(record["text"]) ?? ""] : [];
	}).join("\n\n");
}
/** One counter of a usage report; a present but unusable value is a malformed response, not a zero. */
function countOf(usage, field) {
	const value = usage[field];
	if (value === void 0) return void 0;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new LlmError(`llm-service-lite: openai-responses stream reported an invalid ${field}`, "MALFORMED_RESPONSE");
	return value;
}
/**
* The harness's disjoint token accounting for one terminal event.
*
* This API reports a prompt total with the cached and cache-written parts
* inside it, so those are subtracted out to reach the uncached input count the
* harness contracts for; the total stays the provider's own arithmetic.
* @param usage - the terminal event's usage object, when it carried one.
* @returns token usage, or undefined when the stream reported none.
*/
function usageOf(usage) {
	if (usage === void 0) return void 0;
	const input = countOf(usage, "input_tokens");
	const output = countOf(usage, "output_tokens");
	if (input === void 0 || output === void 0) return void 0;
	const details = asRecord(usage["input_tokens_details"]);
	const cacheRead = countOf(details, "cached_tokens") ?? 0;
	const cacheWrite = countOf(details, "cache_write_tokens") ?? 0;
	return {
		inputTokens: Math.max(0, input - cacheRead - cacheWrite),
		outputTokens: output,
		totalTokens: input + output,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite
	};
}
/**
* The harness finish reason for one terminal event.
*
* This protocol reports a status rather than a reason, and a stream that ended
* on an explicit end-of-stream sentinel without one is still finished: the
* content decides whether it stopped for a call, which is what the harness
* routes on.
* @param status - provider status of the terminal event, when one arrived.
* @param incompleteReason - why an incomplete response stopped, when stated.
* @param sawRefusal - whether the response refused the request.
* @param hasToolCalls - whether the response carried a tool call.
* @param sawEnd - whether an end-of-stream sentinel stood in for the status.
* @returns the finish reason, or undefined when the stream never terminated.
*/
function finishReasonOf(status, incompleteReason, sawRefusal, hasToolCalls, sawEnd) {
	if (status === "incomplete" && incompleteReason === "max_output_tokens") return { kind: "max-tokens" };
	if (sawRefusal) return { kind: "stop" };
	if (hasToolCalls) return { kind: "tool-calls" };
	if (status === "completed" || status === "incomplete") return { kind: "stop" };
	if (sawEnd) return { kind: "stop" };
}
/** The encrypted reasoning payload one serialized item carries, when it has one. */
function encryptedPayloadOf(serialized) {
	let parsed;
	try {
		parsed = JSON.parse(serialized);
	} catch (_unreadableReplayItem) {
		return;
	}
	const encrypted = asRecord(parsed)["encrypted_content"];
	return typeof encrypted === "string" && encrypted.length > 0 ? encrypted : void 0;
}
/**
* Translate one Responses event stream into harness chunks.
*
* @param events - decoded JSON events in arrival order.
* @param sawSentinel - reports whether the transport delivered an end-of-stream
*   sentinel; a gateway may end the turn with one instead of a terminal event.
* @returns the chunk stream, ending with exactly one terminal `finish`.
* @throws LlmError when the stream carries an in-band failure, when it was cut
*   off, or when it ended without stating an outcome.
*/
async function* translateResponsesStream(events, sawSentinel) {
	/** Blocks by the provider identity they were opened under. */
	const slots = /* @__PURE__ */ new Map();
	/** Blocks by the provider's item id, which `output_item.done` may arrive without an index for. */
	const byItemId = /* @__PURE__ */ new Map();
	/** The item id one output index belongs to, announced before its deltas arrive. */
	const itemIdByIndex = /* @__PURE__ */ new Map();
	const replay = [];
	let nextIndex = 0;
	let responseId;
	let status;
	let incompleteReason;
	let usage;
	let sawRefusal = false;
	let sawOutput = false;
	let terminal = false;
	/** Open the block for one provider identity, reporting whether it is new. */
	const ensure = (key, kind) => {
		const existing = slots.get(key);
		if (existing !== void 0) return {
			slot: existing,
			started: false
		};
		const entry = kind === "tool-call" ? { type: "tool-call" } : kind === "text" ? { type: "text" } : { type: "reasoning" };
		const slot = {
			index: nextIndex,
			kind,
			entry,
			text: "",
			arguments: "",
			id: "",
			name: "",
			closed: false
		};
		nextIndex += 1;
		slots.set(key, slot);
		replay.push(entry);
		return {
			slot,
			started: true
		};
	};
	/** Image items already written, so a terminal event does not repeat one. */
	const writtenImages = /* @__PURE__ */ new Set();
	/**
	* Summary parts whose paragraph separator is owed to a following part.
	* Emitting it at `part.done` would leave the block's last part with a
	* trailing blank line, because the closing item's authoritative text is the
	* summaries joined without one.
	*/
	const pendingSeparators = /* @__PURE__ */ new Set();
	/**
	* Chunks one image-generation item contributes: this protocol returns the
	* finished picture inside the item, so the image is one whole block rather
	* than a stream of fragments.
	*/
	const writeImage = (item) => {
		const result = asText(item["result"]);
		if (result === void 0 || result.length === 0) return [];
		const index = nextIndex;
		nextIndex += 1;
		sawOutput = true;
		return [{
			type: "block-start",
			index,
			blockType: "image"
		}, {
			type: "generated-image",
			index,
			...encodedImage(result, "the Responses endpoint")
		}];
	};
	const announce = (slot) => ({
		type: "block-start",
		index: slot.index,
		blockType: slot.kind
	});
	const close = (slot) => {
		slot.closed = true;
		return slot.kind === "tool-call" ? {
			type: "block-end",
			index: slot.index,
			block: {
				type: "tool-call",
				id: ToolCallId(slot.id),
				name: slot.name,
				arguments: slot.arguments
			}
		} : {
			type: "block-end",
			index: slot.index,
			block: {
				type: slot.kind,
				text: slot.text
			}
		};
	};
	/** Remember which item a block came from, so the terminal event can address it. */
	const identify = (slot, itemId) => {
		if (itemId === void 0 || itemId.length === 0) return;
		byItemId.set(itemId, slot);
		slot.entry.itemId = itemId;
	};
	/**
	* Keep the provider's own reasoning item with its block, which is what a
	* model declaring encrypted replay hands back verbatim on the next request.
	*
	* The newest copy usually wins — the terminal event is authoritative — but a
	* copy that lost the payload an earlier copy carried must not replace it:
	* Azure-style endpoints repeat a reasoning item in `response.completed`
	* without its `encrypted_content`, and that payload is exactly what a
	* stateless follow-up turn needs.
	*/
	const keepItem = (slot, item) => {
		const id = asText(item["id"]);
		if (slot.entry.type !== "reasoning" || item["type"] !== "reasoning") return;
		if (id === void 0 || id.length === 0) return;
		const next = JSON.stringify(item);
		if (slot.entry.item !== void 0 && encryptedPayloadOf(slot.entry.item) !== void 0 && encryptedPayloadOf(next) === void 0) return;
		slot.entry.item = next;
	};
	/**
	* Write the block one authoritative call item stands for: a call whose
	* fragments already streamed is completed, and one that never announced
	* itself — an endpoint that only reports it at the end — is written whole.
	* @param item - the authoritative call item.
	* @param itemId - the provider's id for the item.
	* @returns chunks that open and close the block.
	*/
	function* writeCall(item, itemId) {
		if (slots.get(`call:${itemId}`)?.closed === true) return;
		const { slot, started } = ensure(`call:${itemId}`, "tool-call");
		if (slot.id.length === 0) slot.id = asText(item["call_id"]) ?? itemId;
		slot.name = asText(item["name"]) ?? slot.name;
		slot.arguments = asText(item["arguments"]) ?? slot.arguments;
		identify(slot, itemId);
		sawOutput = true;
		if (started) yield {
			type: "block-start",
			index: slot.index,
			blockType: "tool-call"
		};
		yield close(slot);
	}
	/**
	* Write the block one authoritative text or reasoning item stands for.
	*
	* A block the deltas already carried is closed with the longer of the two —
	* an endpoint that sends the rest of its text only in the closing item would
	* otherwise lose it — while a block that never opened is written here in
	* full, so a provider that does not stream still produces its message.
	* @param item - the authoritative item.
	* @param kind - which block the item stands for.
	* @param key - the provider identity its deltas used, when there was one.
	* @param itemId - the provider's id for the item, when it named one.
	* @returns chunks that open and close the block.
	*/
	function* writeItem(item, kind, key, itemId) {
		const authoritative = kind === "text" ? messageItemText(item) : reasoningItemText(item);
		const existing = (key === void 0 ? void 0 : slots.get(key)) ?? (itemId === void 0 ? void 0 : byItemId.get(itemId));
		if (existing === void 0) {
			if (authoritative.length === 0) return;
			const { slot } = ensure(key ?? `item:${kind}:${String(nextIndex)}`, kind);
			sawOutput = true;
			slot.text = authoritative;
			identify(slot, itemId);
			keepItem(slot, item);
			yield announce(slot);
			yield kind === "text" ? {
				type: "text-delta",
				index: slot.index,
				text: authoritative
			} : {
				type: "reasoning-delta",
				index: slot.index,
				text: authoritative
			};
			yield close(slot);
			return;
		}
		if (existing.closed) return;
		identify(existing, itemId);
		keepItem(existing, item);
		if (authoritative.startsWith(existing.text) && authoritative.length > existing.text.length) {
			const suffix = authoritative.slice(existing.text.length);
			existing.text = authoritative;
			yield kind === "text" ? {
				type: "text-delta",
				index: existing.index,
				text: suffix
			} : {
				type: "reasoning-delta",
				index: existing.index,
				text: suffix
			};
		}
		yield close(existing);
	}
	for await (const event of events) {
		const type = event["type"];
		if (type === "error") throw classifyFailure(event, void 0);
		if (type === "response.failed") throw classifyFailure(asRecord(event["response"])["error"] ?? event, void 0);
		if (type === "response.created") {
			const id = asText(asRecord(event["response"])["id"]);
			if (id !== void 0 && id.length > 0) responseId = id;
			continue;
		}
		if (type === "response.output_item.added") {
			const item = asRecord(event["item"]);
			const itemId = asText(item["id"]);
			const outputIndex = event["output_index"];
			if (item["type"] === "function_call" && itemId !== void 0 && itemId.length > 0) {
				const { slot, started } = ensure(`call:${itemId}`, "tool-call");
				slot.id = asText(item["call_id"]) ?? itemId;
				slot.name = asText(item["name"]) ?? "";
				slot.arguments = asText(item["arguments"]) ?? "";
				identify(slot, itemId);
				sawOutput = true;
				if (started) yield announce(slot);
				yield {
					type: "tool-call-delta",
					index: slot.index,
					id: ToolCallId(slot.id),
					name: slot.name,
					argumentsDelta: ""
				};
				continue;
			}
			if ((item["type"] === "message" || item["type"] === "reasoning") && typeof outputIndex === "number") {
				if (itemId !== void 0 && itemId.length > 0) itemIdByIndex.set(outputIndex, itemId);
				const key = `${item["type"] === "message" ? "text" : "reasoning"}:${String(outputIndex)}`;
				const slot = slots.get(key);
				if (slot !== void 0) identify(slot, itemId);
			}
			continue;
		}
		if (type === "response.output_text.delta" || type === "response.refusal.delta") {
			const delta = asText(event["delta"]);
			if (delta === void 0 || delta.length === 0) continue;
			if (type === "response.refusal.delta") sawRefusal = true;
			const outputIndex = event["output_index"];
			const { slot, started } = ensure(`text:${String(outputIndex)}`, "text");
			if (typeof outputIndex === "number") identify(slot, itemIdByIndex.get(outputIndex));
			sawOutput = true;
			if (started) yield announce(slot);
			slot.text += delta;
			yield {
				type: "text-delta",
				index: slot.index,
				text: delta
			};
			continue;
		}
		if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
			const delta = asText(event["delta"]);
			if (delta === void 0 || delta.length === 0) continue;
			const outputIndex = event["output_index"];
			const key = `reasoning:${String(outputIndex)}`;
			const { slot, started } = ensure(key, "reasoning");
			if (typeof outputIndex === "number") identify(slot, itemIdByIndex.get(outputIndex));
			sawOutput = true;
			if (started) yield announce(slot);
			if (pendingSeparators.delete(key)) {
				slot.text += "\n\n";
				yield {
					type: "reasoning-delta",
					index: slot.index,
					text: "\n\n"
				};
			}
			slot.text += delta;
			yield {
				type: "reasoning-delta",
				index: slot.index,
				text: delta
			};
			continue;
		}
		if (type === "response.reasoning_summary_part.done") {
			const key = `reasoning:${String(event["output_index"])}`;
			const slot = slots.get(key);
			if (slot === void 0 || slot.text.length === 0) continue;
			pendingSeparators.add(key);
			continue;
		}
		if (type === "response.function_call_arguments.delta") {
			const itemId = asText(event["item_id"]);
			if (itemId === void 0 || itemId.length === 0) continue;
			const delta = asText(event["delta"]) ?? "";
			const { slot, started } = ensure(`call:${itemId}`, "tool-call");
			if (slot.id.length === 0) slot.id = itemId;
			identify(slot, itemId);
			sawOutput = true;
			if (started) yield announce(slot);
			slot.arguments += delta;
			yield {
				type: "tool-call-delta",
				index: slot.index,
				id: ToolCallId(slot.id),
				argumentsDelta: delta
			};
			continue;
		}
		if (type === "response.function_call_arguments.done") {
			const itemId = asText(event["item_id"]);
			const slot = itemId === void 0 ? void 0 : slots.get(`call:${itemId}`);
			const arguments_ = asText(event["arguments"]);
			if (slot !== void 0 && arguments_ !== void 0) slot.arguments = arguments_;
			continue;
		}
		if (type === "response.output_item.done" || type === "response.completed" || type === "response.incomplete") {
			const response = asRecord(event["response"]);
			if (type === "response.output_item.done") {
				const item = asRecord(event["item"]);
				const itemId = asText(item["id"]);
				const outputIndex = event["output_index"];
				if (item["type"] === "function_call") {
					if (itemId === void 0) continue;
					for (const chunk of writeCall(item, itemId)) yield chunk;
					continue;
				}
				if (item["type"] === "image_generation_call") {
					if (itemId !== void 0) writtenImages.add(itemId);
					for (const chunk of writeImage(item)) yield chunk;
					continue;
				}
				if (item["type"] === "message" || item["type"] === "reasoning") {
					const kind = item["type"] === "message" ? "text" : "reasoning";
					const key = typeof outputIndex === "number" ? `${kind}:${String(outputIndex)}` : void 0;
					for (const chunk of writeItem(item, kind, key, itemId)) yield chunk;
				}
				continue;
			}
			const id = asText(response["id"]);
			if (id !== void 0 && id.length > 0) responseId = id;
			const responseStatus = asText(response["status"]);
			if (responseStatus !== void 0) status = responseStatus;
			const reason = asText(asRecord(response["incomplete_details"])["reason"]);
			if (reason !== void 0) incompleteReason = reason;
			usage = asRecord(response["usage"]);
			terminal = true;
			for (const item of asArray(response["output"])) {
				const record = asRecord(item);
				const itemId = asText(record["id"]);
				const outputIndex = record["output_index"];
				if (record["type"] === "function_call") {
					if (itemId === void 0) continue;
					for (const chunk of writeCall(record, itemId)) yield chunk;
					continue;
				}
				if (record["type"] === "image_generation_call") {
					if (itemId !== void 0 && writtenImages.has(itemId)) continue;
					for (const chunk of writeImage(record)) yield chunk;
					continue;
				}
				if (record["type"] === "message" || record["type"] === "reasoning") {
					const kind = record["type"] === "message" ? "text" : "reasoning";
					const known = itemId === void 0 ? void 0 : byItemId.get(itemId);
					if (known !== void 0) keepItem(known, record);
					const key = typeof outputIndex === "number" ? `${kind}:${String(outputIndex)}` : void 0;
					for (const chunk of writeItem(record, kind, key, itemId)) yield chunk;
				}
			}
			continue;
		}
	}
	if (!terminal && !sawSentinel()) throw new LlmError("llm-service-lite: openai-responses stream ended before a terminal event", "TRANSPORT");
	for (const slot of slots.values()) if (!slot.closed) yield close(slot);
	if (!sawOutput) throw new LlmError("llm-service-lite: openai-responses response carried no content", "EMPTY_RESPONSE");
	const hasToolCalls = [...slots.values()].some((slot) => slot.kind === "tool-call");
	const finish = finishReasonOf(status, incompleteReason, sawRefusal, hasToolCalls, sawSentinel());
	if (finish === void 0) throw new LlmError("llm-service-lite: openai-responses stream ended without an outcome", "TRANSPORT");
	const tokens = usageOf(usage);
	if (tokens !== void 0) yield {
		type: "usage",
		usage: tokens
	};
	yield {
		type: "finish",
		reason: finish,
		replayState: {
			response: {
				kind: RESPONSES_REPLAY_KIND,
				version: 1,
				...status === void 0 ? {} : { stopReason: status },
				...responseId === void 0 ? {} : { responseId }
			},
			blocks: replay
		}
	};
}
//#endregion
//#region lib/types/sse.js
/**
* Server-sent-event framing shared by this adapter's transports.
*
* The idle pulse is raised on data frames only. A gateway that keeps a stalled
* connection alive with `: ping` comments would otherwise renew the watchdog
* forever, which is exactly the half-open connection the watchdog exists to
* catch.
*
* The parser dispatches an event only when a blank line terminates it. A
* gateway that closes the connection right after its last event's single
* newline — observed with endpoints that end on `[DONE]` or `message_stop`
* without the conventional trailing blank line — would otherwise lose that
* frame and turn a complete response into an apparent cut-off. The reader
* therefore appends the missing terminator at end of stream.
*
* @module dsh-llm-service-lite/sse
*/
/** The protocol's end-of-stream sentinel; it carries no JSON payload. */
const DONE_SENTINEL = "[DONE]";
/**
* Ceiling on one buffered SSE event. An endpoint that streams bytes without
* ever emitting an event boundary would otherwise grow the parser buffer
* without bound; exceeding the ceiling is a deterministic protocol failure.
* (Matches the reference transport's 8 MiB guard.)
*/
const MAX_SSE_EVENT_CHARS = 8388608;
/**
* One provider event stream, decoded frame by frame.
*
* `[DONE]` terminates the stream and is remembered rather than yielded, so a
* caller can tell a clean shutdown from a connection that simply stopped. It is
* the chat-completions sentinel; a protocol whose terminal event is in-band (a
* Messages `message_stop`) never sees it, and a gateway that appends one anyway
* is treated as having terminated the stream.
*/
var SseReader = class {
	done = false;
	body;
	activity;
	/**
	* @param body - response bytes to decode.
	* @param activity - pulse raised for every data frame, never for a comment.
	*/
	constructor(body, activity) {
		this.body = body;
		this.activity = activity;
	}
	/** Whether the stream delivered its `[DONE]` sentinel. */
	get sawDone() {
		return this.done;
	}
	/**
	* Decode the stream into JSON events until the sentinel or the last frame.
	* @returns the parsed events in arrival order.
	* @throws LlmError `MALFORMED_RESPONSE` when a frame is invalid JSON or
	*   exceeds the buffer ceiling, and `TRANSPORT` when the connection ended
	*   inside a frame whose remainder never arrived.
	*/
	async *events() {
		let flushed = false;
		const terminate = new TransformStream({ flush(controller) {
			flushed = true;
			controller.enqueue("\n\n");
		} });
		const reader = this.body.pipeThrough(new TextDecoderStream()).pipeThrough(terminate).pipeThrough(new EventSourceParserStream({ maxBufferSize: MAX_SSE_EVENT_CHARS })).getReader();
		try {
			while (true) {
				let next;
				try {
					next = await reader.read();
				} catch (error) {
					throw this.framingFailure(error);
				}
				if (next.done) return;
				const frame = next.value;
				if (frame.data === DONE_SENTINEL) {
					this.done = true;
					return;
				}
				if (frame.data.length === 0) {
					this.activity();
					continue;
				}
				this.activity();
				let raw;
				try {
					raw = JSON.parse(frame.data);
				} catch (_invalidSseJson) {
					throw new LlmError(flushed ? "llm-service-lite: provider stream ended inside an incomplete frame" : "llm-service-lite: provider stream contains invalid JSON", flushed ? "TRANSPORT" : "MALFORMED_RESPONSE");
				}
				if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
				yield raw;
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
	}
	/** Classify one failure raised by the framing pipeline itself. */
	framingFailure(error) {
		if (error instanceof ParseError) return new LlmError(`llm-service-lite: provider stream exceeded ${String(MAX_SSE_EVENT_CHARS)} buffered characters without an event boundary`, "MALFORMED_RESPONSE", { cause: error });
		return error instanceof LlmError ? error : new LlmError("llm-service-lite: provider stream framing failed", "TRANSPORT", { cause: error });
	}
};
//#endregion
//#region lib/types/adapter.js
/**
* The OWC-style adapter: one instance serving every configured route.
*
* A call captures its route's profile before its first await — the endpoint,
* the credential reference, the protocol, and the model's declared facts all
* come from one immutable resolution. A configuration change during the call
* therefore cannot swap the endpoint or the capabilities under a request that
* already started, which is the same guarantee the seam's per-step call freeze
* gives every adapter.
*
* @module dsh-llm-service-lite/adapter
*/
var __addDisposableResource = function(env, value, async) {
	if (value !== null && value !== void 0) {
		if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
		var dispose, inner;
		if (async) {
			if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
			dispose = value[Symbol.asyncDispose];
		}
		if (dispose === void 0) {
			if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
			dispose = value[Symbol.dispose];
			if (async) inner = dispose;
		}
		if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/** Timeout code stamped on this adapter's idle watchdog. */
const IDLE_CODE = "OWC_STREAM_IDLE";
/** Every protocol this adapter serves, by the name a profile declares. */
const TRANSPORTS = {
	"openai-chat-completions": {
		request: chatRequest,
		translate: translateChatStream
	},
	"anthropic-messages": {
		request: anthropicRequest,
		translate: translateAnthropicStream
	},
	"openai-responses": {
		request: responsesRequest,
		translate: translateResponsesStream
	}
};
/** One route's facts, or a refusal naming the route a configuration no longer declares. */
function requireProfile(profiles, provider) {
	const profile = profiles.get(provider);
	if (profile === void 0) throw new LlmError(`llm-service-lite: provider route "${provider}" is not configured`, "INVALID_CONFIG");
	return profile;
}
/** One adapter instance for every configured provider route. */
var OwcProfilesAdapter = class extends LlmAdapter {
	dependencies;
	/**
	* @param dependencies - live profile, limiter, and credential resolution.
	*/
	constructor(dependencies) {
		super();
		this.dependencies = dependencies;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.dependencies.profiles().get(provider)?.displayName ?? provider
		};
	}
	providerRetryPolicy(provider) {
		return this.dependencies.profiles().get(provider)?.retryPolicy;
	}
	listModels(provider) {
		const profile = this.dependencies.profiles().get(provider);
		return Promise.resolve(profile === void 0 ? [] : catalogModels(profile));
	}
	/**
	* Price one model's surface images the way its endpoint charges for them.
	*
	* The token meter asks synchronously, so this reads only the resolved profile
	* and the request target the adapter would ask the attachment provider for.
	* A route that declared no accounting answers `undefined`, which keeps the
	* meter's structural heuristic: a price this adapter made up would be worse
	* than an estimate the meter already labels as one.
	*/
	imageRequestPricing(provider, model) {
		const profile = this.dependencies.profiles().get(provider);
		if (profile === void 0) return void 0;
		return imageRequestPricing(modelOf(profile, model));
	}
	/**
	* Report the exact request-image projection this adapter serializes: the
	* route's declared pixel budget, the adapter's long-edge cap, and the model's
	* encoded-byte target.
	*
	* The seam asks synchronously and without I/O, and its consumers include the
	* CUA screenshot pipeline, which derives the coordinate space it maps model
	* input back into from this answer. Reporting the normalized image instead
	* (the base-class default) would describe a projection the endpoint never
	* receives, so the dimensions a model reasons about and the dimensions it is
	* sent would disagree.
	*/
	imageRequestTarget(provider, model, image) {
		return requestImageTarget(modelOf(requireProfile(this.dependencies.profiles(), provider), model), image);
	}
	resolveModel(provider, model, _signal) {
		return Promise.resolve().then(() => resolvedModelInfo(requireProfile(this.dependencies.profiles(), provider), model));
	}
	prepareCall(provider, model, _signal) {
		return Promise.resolve().then(() => {
			const profile = requireProfile(this.dependencies.profiles(), provider);
			return {
				model: resolvedModelInfo(profile, model),
				stream: (options) => this.generate(options, profile)
			};
		});
	}
	stream(options) {
		return this.generate(options);
	}
	/**
	* Run one request under its route's admission slot and idle watchdog.
	* The route resolution happens inside the generator, so an unconfigured
	* route surfaces as a stream failure the runtime normalizes rather than as
	* a synchronous throw from `stream()`.
	*/
	async *generate(options, captured) {
		const env_1 = {
			stack: [],
			error: void 0,
			hasError: false
		};
		try {
			const profile = captured ?? requireProfile(this.dependencies.profiles(), options.provider);
			const consumer = new AbortController();
			const signal = options.signal === void 0 ? consumer.signal : AbortSignal.any([consumer.signal, options.signal]);
			const watchdog = __addDisposableResource(env_1, idleWatchdog(signal, profile.streamIdleTimeoutMs, IDLE_CODE), false);
			let iterator;
			let lease;
			try {
				lease = await this.dependencies.limiter(profile.provider).acquire(signal);
				iterator = this.request(options, profile, watchdog.signal, () => {
					watchdog.pulse();
				});
				while (true) {
					const next = await watchdog.next(iterator);
					if (next.done) return;
					yield next.value;
				}
			} catch (error) {
				if (timeoutOf(watchdog.signal, IDLE_CODE) !== void 0) throw new LlmError(`llm-service-lite: provider "${profile.provider}" stream idle timeout`, "TIMEOUT", { cause: error });
				throw classifyTransport(error, options.signal?.aborted === true);
			} finally {
				lease?.release();
				consumer.abort();
				if (iterator !== void 0) iterator.return(void 0).catch(() => {});
			}
		} catch (e_1) {
			env_1.error = e_1;
			env_1.hasError = true;
		} finally {
			__disposeResources(env_1);
		}
	}
	/** Issue the HTTP request and translate its event stream. */
	async *request(options, profile, signal, activity) {
		signal.throwIfAborted();
		const model = modelOf(profile, options.model);
		const apiKey = await this.dependencies.resolveApiKey(profile);
		const versions = await prepareRequestImages(model, options.messages, this.dependencies.resolveAttachments?.(), profile.imageRequestBudget, signal);
		signal.throwIfAborted();
		const transport = TRANSPORTS[profile.interfaceType];
		const request = transport.request(profile, model, options, apiKey, versions);
		const response = await fetch(request.url, {
			method: "POST",
			headers: request.headers,
			body: request.body,
			signal,
			redirect: "error"
		});
		if (!response.ok) {
			const text = await response.text();
			let raw;
			try {
				raw = JSON.parse(text);
			} catch (_nonJsonGatewayError) {
				raw = { message: text.slice(0, 2e3) };
			}
			throw classifyFailure(raw, response.status, response.headers);
		}
		if (response.body === null) throw new LlmError(`llm-service-lite: provider "${profile.provider}" returned no response body`, "EMPTY_RESPONSE");
		const reader = new SseReader(response.body, activity);
		yield* this.materializeImages(model, transport.translate(reader.events(), () => reader.sawDone));
	}
	/**
	* Commit every image the endpoint returned and republish it as a durable
	* block.
	*
	* The wire translators carry bytes, not attachments: this is the one place
	* that knows the route, so it is where a route that never declared image
	* output fails by name, where a deployment without an attachment provider
	* fails rather than losing the picture, and where the session ends up
	* holding a reference instead of base64.
	*
	* @param model - the route's declared facts for this model.
	* @param chunks - the transport's chunk stream.
	* @yields harness chunks, with each generated image replaced by its block.
	*/
	async *materializeImages(model, chunks) {
		for await (const chunk of chunks) {
			if (!isGeneratedImage(chunk)) {
				yield chunk;
				continue;
			}
			if (!model.imageOutput) throw new LlmError(`llm-service-lite: model "${model.id}" returned an image without declaring image output; declare capabilities.imageOutput on the model so the route states what it serves`, "UNSUPPORTED_CONTENT");
			const attachments = this.dependencies.resolveAttachments?.();
			if (attachments === void 0) throw new LlmError(`llm-service-lite: model "${model.id}" returned an image and no attachment provider is mounted; load @deepseek-ai/dsh-attachment-local (or another provider) to store it`, "INVALID_CONFIG");
			const [attachment] = await attachments.saveImages([{
				data: chunk.data,
				mediaType: chunk.mediaType
			}]);
			if (attachment === void 0) throw new LlmError(`llm-service-lite: the attachment provider returned no reference for an image from "${model.id}"`, "EMPTY_RESPONSE");
			yield {
				type: "block-end",
				index: chunk.index,
				block: generatedImageBlock(attachment)
			};
		}
	}
};
//#endregion
//#region lib/types/discovery.js
/**
* Endpoint interrogation for configuration surfaces.
*
* Asking a provider what it serves is a configuration-time action over a
* draft, so the answer is advisory: nothing is stored and nothing is
* registered — the profile a user saves decides what a route serves.
*
* The listing is protocol-aware, mirroring the harness's own discovery seam:
* OpenAI-compatible endpoints list at `{baseURL}/models` with a bearer token,
* while an Anthropic Messages endpoint lists at `{root}/v1/models` with
* `x-api-key` and `anthropic-version`. The request is bounded because the
* endpoint is whatever URL the user typed, and an oversized or unreadable reply
* is reported as a discovery failure rather than as a JSON or header TypeError
* from deeper in the runtime.
*
* @module dsh-llm-service-lite/discovery
*/
/** How long an endpoint interrogation may take before it is abandoned. */
const DISCOVERY_TIMEOUT_MS = 1e4;
/** Largest listing body accepted from an endpoint the caller typed. */
const DISCOVERY_MAX_RESPONSE_BYTES = 4194304;
/** Stable API version required by Anthropic's model-listing endpoint. */
const ANTHROPIC_VERSION = "2023-06-01";
/** Largest page accepted by Anthropic's public listing; discovery reads one page. */
const ANTHROPIC_MODEL_LIMIT = 1e3;
/**
* Wire protocols whose model listing this module can read. The vocabulary is
* this adapter's own `interfaceType`, so a caller that names a protocol is not
* left guessing how the plugin spells it.
*/
const LISTABLE_INTERFACE_TYPES = [
	"openai-chat-completions",
	"anthropic-messages",
	"openai-responses"
];
/**
* The URL one protocol lists its models at.
*
* The base is treated as a prefix rather than a URL to resolve against, so a
* deployment path such as `https://gateway.example/openai/v1` keeps its
* segments. Anthropic publishes both `{root}/v1` and `{root}` spellings of its
* base, so one trailing `/v1` is folded into the listing path. Only the
* listing URL normalizes that segment; model requests receive the configured
* `baseURL` unchanged.
* @param baseURL - the route's endpoint.
* @param interfaceType - protocol the endpoint speaks.
* @returns the listing URL.
*/
function listingUrl(baseURL, interfaceType) {
	const base = baseURL.replace(/\/+$/u, "");
	if (interfaceType !== "anthropic-messages") return `${base}/models`;
	return `${base.endsWith("/v1") ? base.slice(0, -3) : base}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`;
}
/**
* Headers for one listing request: the route's own configured headers first,
* then the protocol's credential spelling, then the harness attribution. A
* configured header can authenticate or route the request when the profile
* names no key; attribution is written last so a configured map cannot drop it.
* @param interfaceType - protocol the endpoint speaks.
* @param apiKey - resolved credential, when one exists.
* @param configured - static headers configured on the route.
* @returns the request headers.
*/
function listingHeaders(interfaceType, apiKey, configured) {
	const headers = new Headers(configured === void 0 ? void 0 : Object.entries(configured));
	headers.set("accept", "application/json");
	if (interfaceType === "anthropic-messages") {
		headers.set("anthropic-version", ANTHROPIC_VERSION);
		if (apiKey !== void 0 && apiKey.length > 0) headers.set("x-api-key", apiKey);
	} else if (apiKey !== void 0 && apiKey.length > 0) headers.set("authorization", `Bearer ${apiKey}`);
	for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value);
	return headers;
}
/** The refusal for a listing body that outgrows the ceiling. */
function oversizedBody(url) {
	return new LlmError(`llm-service-lite: ${url} answered with more than ${String(DISCOVERY_MAX_RESPONSE_BYTES)} bytes`, "DISCOVERY_FAILED");
}
/**
* Read one listing body under the byte ceiling.
*
* The caller-supplied endpoint decides how much it sends, so the bound holds on
* the bytes actually read rather than on the length the server claims: a
* declared length is checked first (an honest server is turned away without
* transferring anything), then the running total enforces the same ceiling for
* a server that under-declares or streams.
* @param response - the listing response.
* @param url - the listing URL, for diagnostics.
* @returns the decoded body.
* @throws LlmError `DISCOVERY_FAILED` when the body exceeds the ceiling.
*/
async function readListingBody(response, url) {
	const declared = Number(response.headers.get("content-length") ?? NaN);
	if (Number.isFinite(declared) && declared > 4194304) {
		await response.body?.cancel().catch(() => {});
		throw oversizedBody(url);
	}
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > 4194304) {
			await reader.cancel().catch(() => {});
			throw oversizedBody(url);
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}
/**
* Interrogate an endpoint for the models it serves.
*
* Both published OpenAI-compatible listing shapes are accepted: the standard
* `data` array and the enriched `models` map some gateways return. An
* Anthropic Messages endpoint is read through its native listing shape, which
* is a `data` array with a `display_name` field. Every field except the id is
* optional, because a gateway that lists only ids is answering the question.
*
* @param baseURL - the route's endpoint.
* @param apiKey - resolved credential, when the route authenticates.
* @param signal - caller cancellation, fused with the interrogation timeout.
* @param options - protocol and configured headers the route states.
* @returns discovered models, in the order the endpoint listed them.
* @throws LlmError `INVALID_CONFIG` for a protocol no listing can be read for,
*   `ABORTED` when the caller cancels, `INVALID_REQUEST` when the endpoint
*   answers with an error status, and `DISCOVERY_FAILED` when it cannot be
*   reached or answers with an unreadable or oversized body.
*/
async function discoverEndpointModels(baseURL, apiKey, signal, options = {}) {
	const interfaceType = options.api ?? "openai-chat-completions";
	if (!LISTABLE_INTERFACE_TYPES.includes(interfaceType)) throw new LlmError(`llm-service-lite: model discovery cannot read a "${interfaceType}" listing; it reads ${LISTABLE_INTERFACE_TYPES.join(", ")} — enter this provider's models by hand`, "INVALID_CONFIG");
	const url = listingUrl(baseURL, interfaceType);
	const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	const fused = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
	let response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: listingHeaders(interfaceType, apiKey, options.headers),
			signal: fused,
			redirect: "error"
		});
	} catch (error) {
		if (signal?.aborted === true) throw new LlmError("llm-service-lite: model discovery aborted by caller", "ABORTED", { cause: error });
		throw new LlmError(`llm-service-lite: could not reach ${url}`, "DISCOVERY_FAILED", { cause: error });
	}
	if (!response.ok) {
		let text = "";
		try {
			text = await readListingBody(response, url);
		} catch (error) {
			if (signal?.aborted === true) throw new LlmError("llm-service-lite: model discovery aborted by caller", "ABORTED", { cause: error });
		}
		throw new LlmError(`llm-service-lite: model listing failed (${String(response.status)}): ${text.slice(0, 500)}`, "INVALID_REQUEST", { status: response.status });
	}
	let text;
	try {
		text = await readListingBody(response, url);
	} catch (error) {
		if (signal?.aborted === true) throw new LlmError("llm-service-lite: model discovery aborted by caller", "ABORTED", { cause: error });
		if (error instanceof LlmError) throw error;
		throw new LlmError(`llm-service-lite: could not read the model listing from ${url}`, "DISCOVERY_FAILED", { cause: error });
	}
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new LlmError(`llm-service-lite: ${url} did not answer with JSON`, "DISCOVERY_FAILED", { cause: error });
	}
	return parseListing(raw);
}
/** Every entry of either supported listing shape, in endpoint order. */
function listingEntries(raw) {
	const envelope = typeof raw === "object" && raw !== null ? raw : {};
	if (Array.isArray(envelope.data)) return envelope.data.map((value) => [void 0, value]);
	if (typeof envelope.models === "object" && envelope.models !== null && !Array.isArray(envelope.models)) return Object.entries(envelope.models);
	return [];
}
/** The first non-empty string among the candidates. */
function firstString(...candidates) {
	for (const candidate of candidates) if (typeof candidate === "string" && candidate.length > 0) return candidate;
}
/** The first candidate that is a positive safe integer. */
function firstPositiveInteger(...candidates) {
	for (const candidate of candidates) if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) return candidate;
}
/**
* Read either listing shape into discovered models, dropping unusable entries
* and repeated ids while preserving endpoint order.
* @param raw - the decoded listing.
* @returns the discovered models.
*/
function parseListing(raw) {
	const models = [];
	const seen = /* @__PURE__ */ new Set();
	for (const [key, value] of listingEntries(raw)) {
		if (typeof value !== "object" || value === null) continue;
		const entry = value;
		const id = firstString(entry.id, entry.model) ?? (key === "" ? void 0 : key);
		if (id === void 0 || seen.has(id)) continue;
		seen.add(id);
		const name = firstString(entry.name, entry.display_name, entry.displayName);
		const contextWindow = firstPositiveInteger(entry.context_length, entry.context_window, entry.contextWindow, entry.max_input_tokens);
		const maxTokens = firstPositiveInteger(entry.max_tokens, entry.max_output_tokens, entry.maxTokens, entry.maxOutputTokens);
		models.push({
			id,
			...name === void 0 ? {} : { name },
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxTokens === void 0 ? {} : { maxTokens }
		});
	}
	return models;
}
//#endregion
//#region lib/types/limiter.js
/**
* Per-route admission control.
*
* OWC holds each provider to three concurrent requests, and the reason is
* worth preserving in a different runtime: a provider is a rate-limited shared
* resource, so a swarm that fans out twenty subagents must queue behind the
* provider rather than discover the limit as a wave of 429s. Waiting is
* abortable, because a cancelled turn must not keep its place in line.
*
* @module dsh-llm-service-lite/limiter
*/
/** The cancellation failure every abandoned wait reports. */
function abortedWhileQueueing() {
	return new LlmError("llm-service-lite: request aborted while queueing", "ABORTED");
}
/** Validate one admission ceiling. */
function assertLimit(maxConcurrent) {
	if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error(`ConcurrencyLimiter maxConcurrent must be a positive safe integer, received ${String(maxConcurrent)}`);
}
/**
* A FIFO admission queue with a tunable number of slots.
*
* A released slot is handed to the next waiter rather than returned to a pool,
* so a request that arrives between a release and the handoff cannot overtake
* one that has been waiting. The ceiling is tunable in place: a configuration
* edit that changes a route's concurrency must keep this one queue, both so
* waiting requests are never split between two limiter instances and so the
* new ceiling is the only ceiling admission can use from then on. Requests
* already running are never preempted.
*/
var ConcurrencyLimiter = class {
	active = 0;
	limit;
	waiters = [];
	/**
	* @param maxConcurrent - slots this limiter grants before queueing.
	*/
	constructor(maxConcurrent) {
		assertLimit(maxConcurrent);
		this.limit = maxConcurrent;
	}
	/** Requests currently holding a slot. */
	get running() {
		return this.active;
	}
	/** Requests currently waiting for a slot. */
	get queued() {
		return this.waiters.length;
	}
	/** Slots this limiter currently grants before queueing. */
	get maxConcurrent() {
		return this.limit;
	}
	/**
	* Re-tune the admission ceiling in place.
	*
	* A raised ceiling admits queued requests immediately; a lowered one stops
	* further admissions until running requests drop below it, without
	* interrupting any request that already holds a slot.
	* @param maxConcurrent - the next positive number of slots.
	*/
	setMaxConcurrent(maxConcurrent) {
		assertLimit(maxConcurrent);
		if (maxConcurrent === this.limit) return;
		this.limit = maxConcurrent;
		this.pump();
	}
	/**
	* Acquire one slot, waiting in FIFO order when all are held.
	* @param signal - cancellation for the wait; an already-aborted signal never queues.
	* @returns the lease whose `release()` frees the slot.
	*/
	acquire(signal) {
		if (signal?.aborted === true) return Promise.reject(abortedWhileQueueing());
		if (this.active < this.limit && this.waiters.length === 0) {
			this.active += 1;
			return Promise.resolve(this.lease());
		}
		return new Promise((resolve, reject) => {
			const waiter = {
				signal,
				settle: resolve,
				fail: reject,
				onAbort: () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(abortedWhileQueueing());
				}
			};
			signal?.addEventListener("abort", waiter.onAbort, { once: true });
			this.waiters.push(waiter);
		});
	}
	/** Build the lease that eventually frees its slot. */
	lease() {
		let released = false;
		return { release: () => {
			if (released) return;
			released = true;
			this.active = Math.max(0, this.active - 1);
			this.pump();
		} };
	}
	/** Admit queued requests while slots remain, skipping ones that were cancelled. */
	pump() {
		while (this.active < this.limit && this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			if (waiter === void 0) return;
			waiter.signal?.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal?.aborted === true) {
				waiter.fail(abortedWhileQueueing());
				continue;
			}
			this.active += 1;
			waiter.settle(this.lease());
		}
	}
};
//#endregion
//#region lib/types/index.js
/**
* OWC-style provider profiles for the DeepSeek Harness LLM seam.
*
* One plugin instance owns a dict of provider profiles; every enabled profile
* registers one route on `ctx.llm`, and the route serves the models its
* profile declares. This is the shape OpenWebCode gives a provider — a
* self-contained endpoint plus the catalog it serves — carried onto the
* harness seam, so a deployment configures providers once, in one place, and a
* gateway reaches the same code path as a first-party endpoint.
*
* The package is also its own bundle: `cordis.patch.yml` inserts the plugin row
* below, so installing it into a profile mounts it without a hand-written
* entry. A composition that mounts the row itself — as this example does —
* declares no bundle layer and uses the row's own `id` and `name`.
*
* ```yaml
* - id: llm-service-lite
*   name: '@snnh/dsh-llm-service-lite'
*   config:
*     providers:
*       deepseek-direct:
*         displayName: DeepSeek
*         interfaceType: openai-chat-completions
*         baseURL: https://api.deepseek.com/v1
*         apiKeyEnv: DEEPSEEK_API_KEY
*         includeUsage: true
*         models:
*           - id: deepseek-chat
*             contextWindow: 131072
*             maxTokens: 8192
*             capabilities:
*               modalities: [text]
*           - id: deepseek-reasoner
*             contextWindow: 131072
*             maxTokens: 65536
*             capabilities:
*               modalities: [text]
*               effort: [low, medium, high]
*               thinking: [enabled, disabled]
*               reasoningContent: true
* ```
*
* @module @snnh/dsh-llm-service-lite
*/
/**
* Plugin name, and the settings namespace this instance owns when its mounting
* row declares the same id — which `cordis.patch.yml` does.
*/
const name = "llm-service-lite";
/** The LLM service this plugin registers provider routes on. */
const inject = ["llm"];
const NS = "llm-service-lite";
/**
* Register every configured provider profile as a route on the LLM service.
* @param ctx - plugin lifetime with the LLM registry injected.
* @param config - the `providers` dict of profiles.
*/
function apply(ctx, config) {
	ctx.inject(["settings"], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
	});
	const settingsNs = ctx.fiber.entry?.options.id ?? NS;
	let lastRaw;
	let memoized;
	/** Resolved profiles for the current configuration, memoized by raw snapshot identity. */
	const profiles = () => {
		const raw = config.providers.get();
		if (raw === lastRaw && memoized !== void 0) return memoized;
		const next = resolveProfiles(structuredClone(raw), "deferred");
		lastRaw = raw;
		memoized = next;
		return next;
	};
	profiles();
	/** Route names this instance currently owns, tracked across registration swaps. */
	const ownRoutes = /* @__PURE__ */ new Set();
	/**
	* Provider names another mounted adapter family currently owns, mapped to a
	* label for the owner. A route or directory entry belongs to another family
	* when it comes from a different settings namespace, or when it is registered
	* by an adapter other than this one: both registries are keyed globally by
	* the route name, so a second claim on one name is refused.
	*/
	const foreignClaims = () => {
		const claims = /* @__PURE__ */ new Map();
		for (const entry of ctx.llm.listConfigurableProviders()) {
			if (entry.settingsNs === settingsNs) continue;
			claims.set(entry.provider, `the "${entry.settingsNs}" configuration namespace`);
		}
		for (const provider of ctx.llm.listProviders()) {
			if (claims.has(provider.id) || ownRoutes.has(provider.id)) continue;
			claims.set(provider.id, "another mounted adapter");
		}
		return claims;
	};
	/**
	* A stable signature of the foreign claims: the topology listener compares it
	* against the last reconciled snapshot so this instance's own commits (which
	* fire the same event) cannot re-enter the reconcile in a loop.
	*/
	const claimSignature = (claims) => [...claims].map(([provider, owner]) => `${provider}\u0000${owner}`).sort().join("");
	ctx.on("internal/config", function(_raw, next) {
		const raw = next();
		if (this !== ctx.fiber) return raw;
		const candidate = Config(raw);
		const previousProviders = structuredClone(config.providers.get());
		assertServiceable({ providers: structuredClone(candidate.providers.get()) }, { providers: previousProviders });
		const claims = foreignClaims();
		const existing = new Set(Object.keys(previousProviders));
		for (const provider of Object.keys(structuredClone(candidate.providers.get()))) {
			if (existing.has(provider)) continue;
			const owner = claims.get(provider);
			if (owner !== void 0) throw new Error(`llm-service-lite: provider route "${provider}" is already declared by ${owner}; choose a different route name`);
		}
		return raw;
	});
	/**
	* Resolve one route's credential. A profile that names no credential at all
	* is deliberately unauthenticated — some gateways in front of a local model
	* want no key — while a named reference that resolves to nothing fails the
	* request, because silently sending it unauthenticated would bill or blame
	* the wrong tenant.
	*/
	const resolveApiKey = async (profile) => {
		const ref = profile.apiKeyEnv;
		if (ref === void 0) return profile.apiKey;
		const credentials = ctx.get("credentials");
		const hit = credentials !== void 0 ? (await credentials.resolve(ref))?.value : launchEnvironmentOf(ctx).get(ref)?.value;
		if (hit !== void 0 && hit.length > 0) return assertUsableApiKey(hit, name, ref);
		throw new LlmError(`llm-service-lite: no credential for provider route "${profile.provider}"; its profile resolves ${ref}, which is not set — store ${ref} through the credentials service or export it`, "MISSING_CREDENTIAL");
	};
	/**
	* One admission limiter per route. The limiter is re-tuned in place rather
	* than replaced: it carries the FIFO queue of requests already waiting, so
	* rebuilding it would split that queue across two instances and let the old
	* and new ceilings admit at the same time.
	*/
	const limiters = /* @__PURE__ */ new Map();
	const limiterFor = (provider) => {
		const maxConcurrent = profiles().get(provider)?.maxConcurrent ?? 1;
		const current = limiters.get(provider);
		if (current !== void 0) {
			current.setMaxConcurrent(maxConcurrent);
			return current;
		}
		const limiter = new ConcurrencyLimiter(maxConcurrent);
		limiters.set(provider, limiter);
		return limiter;
	};
	const adapter = new OwcProfilesAdapter({
		profiles,
		limiter: limiterFor,
		resolveApiKey,
		resolveAttachments: () => ctx.get("attachments")
	});
	let directory;
	let registeredDirectory;
	let reportedCatalogDiagnostics;
	let reportedConflicts;
	/**
	* Report what a catalog conversion could not carry, once per distinct set.
	* The route still serves; these lines are what keeps a lossy conversion from
	* looking whole.
	*/
	const reportCatalogDiagnostics = () => {
		const notes = [...profiles().values()].flatMap((profile) => profile.catalogDiagnostics);
		if (deepEqualJson(notes, reportedCatalogDiagnostics)) return;
		reportedCatalogDiagnostics = notes;
		for (const note of notes) ctx.logger.warn(note);
	};
	/**
	* Report one actionable warning per route name another adapter family owns,
	* once per distinct conflict set. The profile is skipped, not mounted: one
	* collision must not abort the whole mount, because a stock upstream profile
	* always mounts `llm-pi-ai`, whose shipped catalog declares common route
	* names such as `deepseek` and `openai`. Renaming the route is the fix, and a
	* later topology change re-attempts the profile (see the listener below).
	*/
	const reportConflicts = (claims) => {
		const conflicts = [...profiles().values()].filter((profile) => claims.has(profile.provider)).map((profile) => ({
			provider: profile.provider,
			owner: claims.get(profile.provider)
		})).sort((left, right) => left.provider.localeCompare(right.provider));
		if (deepEqualJson(conflicts, reportedConflicts)) return;
		reportedConflicts = conflicts;
		for (const conflict of conflicts) ctx.logger.warn(`llm-service-lite: provider route "${conflict.provider}" is already declared by ${conflict.owner}; this profile is skipped — rename its route to mount it`);
	};
	const ensureDirectory = (claims) => {
		const entries = [...profiles().values()].filter((profile) => !claims.has(profile.provider)).map((profile) => ({
			provider: profile.provider,
			displayName: profile.displayName,
			settingsNs,
			settingsPath: ["providers", profile.provider],
			declared: true,
			...profile.diagnostic === void 0 ? {} : { error: profile.diagnostic }
		}));
		if (deepEqualJson(entries, registeredDirectory)) return;
		if (entries.length === 0) {
			directory?.();
			directory = void 0;
			registeredDirectory = entries;
			return;
		}
		if (directory === void 0) directory = ctx.llm.registerConfigurableProviders(entries);
		else directory.replace(entries);
		registeredDirectory = entries;
	};
	ctx.llm.registerModelDefaults?.(settingsNs, (request) => Promise.resolve(request.models.flatMap((id) => {
		const declared = declaredDefaultsOf(id, request.api);
		return declared === void 0 ? [] : [declared];
	})));
	ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => {
		const stored = request.provider === void 0 ? void 0 : profiles().get(request.provider);
		const baseURL = request.baseURL ?? stored?.baseURL;
		if (baseURL === void 0) throw new LlmError("llm-service-lite: model discovery needs a baseURL", "INVALID_CONFIG");
		const api = request.api ?? stored?.interfaceType;
		const options = {
			...api === void 0 ? {} : { api },
			...stored === void 0 ? {} : { headers: stored.headers }
		};
		const discover = (apiKey) => discoverEndpointModels(baseURL, apiKey, signal, options);
		if (request.apiKey !== void 0) return discover(assertUsableApiKey(request.apiKey, name, "request.apiKey"));
		if (stored === void 0) return discover(void 0);
		return resolveApiKey(stored).then(discover);
	});
	let registration;
	let registeredFacts;
	const ensureRegistration = (claims) => {
		const routes = serviceableRoutes(profiles()).filter((provider) => !claims.has(provider));
		const mounted = /* @__PURE__ */ new Map();
		for (const provider of routes) {
			const profile = profiles().get(provider);
			if (profile !== void 0) mounted.set(provider, profile);
		}
		const facts = {
			routes: [...routes].sort(),
			registration: registrationFacts(mounted)
		};
		if (deepEqualJson(facts, registeredFacts)) return;
		const previousOwnRoutes = new Set(ownRoutes);
		ownRoutes.clear();
		for (const provider of routes) ownRoutes.add(provider);
		try {
			if (registration === void 0) {
				if (routes.length === 0) {
					registeredFacts = facts;
					return;
				}
				registration = ctx.llm.registerAdapter(routes, adapter);
			} else registration.replace(routes);
		} catch (error) {
			ownRoutes.clear();
			for (const provider of previousOwnRoutes) ownRoutes.add(provider);
			throw error;
		}
		registeredFacts = facts;
	};
	/** A registry refusal that a foreign adapter claiming a name after the claims snapshot explains. */
	const isRegistrationConflict = (error) => error instanceof LlmError && (error.code === "DUPLICATE_DIRECTORY" || error.code === "DUPLICATE_ADAPTER");
	/** The foreign-claims snapshot the last reconcile observed; '' until the first pass. */
	let observedClaims = "";
	/**
	* Reconcile the configurable-provider directory and this instance's routes
	* with the current configuration and with the names other mounted adapters
	* own. Idempotent: a pass that changes nothing commits nothing.
	*/
	const reconcile = () => {
		let retried = false;
		for (;;) {
			const claims = foreignClaims();
			observedClaims = claimSignature(claims);
			try {
				reportCatalogDiagnostics();
				reportConflicts(claims);
				ensureDirectory(claims);
				ensureRegistration(claims);
				return;
			} catch (error) {
				if (retried || !isRegistrationConflict(error)) throw error;
				retried = true;
			}
		}
	};
	let syncing = false;
	let resyncQueued = false;
	/** Run a full reconcile, coalescing a request that arrives while one is in flight. */
	const sync = () => {
		if (syncing) {
			resyncQueued = true;
			return;
		}
		syncing = true;
		try {
			let passes = 0;
			do {
				resyncQueued = false;
				reconcile();
				passes += 1;
			} while (resyncQueued && passes < 4);
		} finally {
			syncing = false;
		}
	};
	sync();
	ctx.on("llm/adapters-updated", () => {
		try {
			if (claimSignature(foreignClaims()) === observedClaims) return;
			sync();
		} catch (error) {
			ctx.logger.error("llm-service-lite: reconciling with the provider registry failed");
			ctx.logger.error(error);
		}
	});
	ctx.on("loader/volatile-update", () => {
		try {
			sync();
		} catch (error) {
			ctx.logger.error("llm-service-lite: configuration conflicts with an existing provider route");
			ctx.logger.error(error);
		}
	});
}
//#endregion
export { ConcurrencyLimiter, Config, DISCOVERY_MAX_RESPONSE_BYTES, LISTABLE_INTERFACE_TYPES, OwcProfilesAdapter, apply, convertOfficialProvider, discoverEndpointModels, inject, modelOf, name, resolveProfiles };
