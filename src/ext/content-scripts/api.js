async function setValue(key, value) {
	if (typeof key !== "string" || !key.length) {
		return Promise.reject(new Error("setValue invalid key arg"));
	}
	const sid = this.US_filename;
	if (typeof sid !== "string" || !sid.length) {
		return Promise.reject(new Error("setValue invalid call"));
	}
	const item = {};
	item[`${sid}---${key}`] = value;
	return browser.storage.local.set(item);
}

async function getValue(key, defaultValue) {
	if (typeof key !== "string" || !key.length) {
		return Promise.reject(new Error("getValue invalid key arg"));
	}
	const sid = this.US_filename;
	if (typeof sid !== "string" || !sid.length) {
		return Promise.reject(new Error("getValue invalid call"));
	}
	const prefixedKey = `${sid}---${key}`;
	const results = await browser.storage.local.get(prefixedKey);
	if (prefixedKey in results) return results[prefixedKey];
	if (defaultValue !== undefined) return defaultValue;
	return undefined;
}

async function deleteValue(key) {
	if (typeof key !== "string" || !key.length) {
		return Promise.reject(new Error("deleteValue missing key arg"));
	}
	const sid = this.US_filename;
	if (typeof sid !== "string" || !sid.length) {
		return Promise.reject(new Error("deleteValue invalid call"));
	}
	const prefixedKey = `${sid}---${key}`;
	return browser.storage.local.remove(prefixedKey);
}

async function listValues() {
	const sid = this.US_filename;
	if (typeof sid !== "string" || !sid.length) {
		return Promise.reject(new Error("listValues invalid call"));
	}
	const prefix = `${sid}---`;
	const results = await browser.storage.local.get();
	const keys = [];
	for (const key in results) {
		key.startsWith(prefix) && keys.push(key.slice(prefix.length));
	}
	return keys;
}

async function sendMessageProxy(message) {
	try {
		/** @type {{status: "fulfilled"|"rejected", result: any}} */
		const response = await browser.runtime.sendMessage(message);
		if (response.status === "fulfilled") {
			return response.result;
		} else {
			return Promise.reject(response.result);
		}
	} catch (error) {
		console.error(error);
		return Promise.reject(error);
	}
}

const XHR_ALLOWED_METHODS = new Set([
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
]);
const XHR_ALLOWED_RESPONSE_TYPES = new Set([
	"",
	"text",
	"json",
	"blob",
	"arraybuffer",
	"document",
]);
const XHR_FORBIDDEN_HEADERS = new Set([
	"authorization",
	"connection",
	"content-length",
	"cookie",
	"cookie2",
	"host",
	"origin",
	"referer",
	"proxy-authorization",
	"proxy-connection",
	"www-authenticate",
]);
const XHR_FORBIDDEN_HEADER_PREFIXES = ["proxy-", "sec-"];
const XHR_MAX_TIMEOUT_MS = 120_000;
const XHR_MAX_HEADER_VALUE_LENGTH = 8192;
const XHR_MAX_HEADER_COUNT = 64;
const PAGE_DATA_TIMEOUT_MS = 5000;
const PAGE_DATA_MAX_EXTRACTOR_BYTES = 100_000;
const PAGE_DATA_MAX_ARGS_BYTES = 256 * 1024;
const PAGE_DATA_MAX_RESULT_BYTES = 2 * 1024 * 1024;
const PAGE_DATA_MAX_DEPTH = 32;
const PAGE_DATA_MAX_ARRAY_LENGTH = 4096;
const PAGE_DATA_MAX_OBJECT_KEYS = 128;
const PAGE_DATA_MAX_OBJECT_KEY_LENGTH = 512;
const PAGE_DATA_MAX_CALLS_PER_WINDOW = 20;
const PAGE_DATA_RATE_WINDOW_MS = 1000;
const PAGE_DATA_MAX_ACTIVE_CALLS = 8;
const PAGE_CALL_TIMEOUT_MS = 5000;
const PAGE_CALL_MAX_ARGS_BYTES = 64 * 1024;
const PAGE_CALL_MAX_RESULT_BYTES = 256 * 1024;
const PAGE_CALL_MAX_OPERATION_LENGTH = 64;
const PAGE_CALL_MAX_SELECTOR_LENGTH = 4096;
const PAGE_CALL_MAX_EVENT_TYPE_LENGTH = 128;
const PAGE_CALL_MAX_EVENT_STRING_LENGTH = 512;
const PAGE_CALL_MAX_CALLS_PER_WINDOW = 20;
const PAGE_CALL_RATE_WINDOW_MS = 1000;
const PAGE_CALL_MAX_ACTIVE_CALLS = 8;
const PAGE_CALL_ALLOWED_OPERATIONS = new Set([
	"dom.queryText",
	"dom.click",
	"event.dispatch",
]);
const PAGE_CALL_ALLOWED_EVENT_KINDS = new Set([
	"event",
	"custom",
	"mouse",
	"keyboard",
	"input",
]);
const pageDataTextEncoder =
	typeof TextEncoder === "function" ? new TextEncoder() : null;
const safeFunctionToString = Function.prototype.call.bind(
	Function.prototype.toString,
);
const safePageAddEventListener = Function.prototype.call.bind(
	EventTarget.prototype.addEventListener,
);
const safePageRemoveEventListener = Function.prototype.call.bind(
	EventTarget.prototype.removeEventListener,
);
const safeCreateElement = Function.prototype.call.bind(
	Document.prototype.createElement,
);
const safeAttachShadow = Function.prototype.call.bind(
	Element.prototype.attachShadow,
);
const safeAppendChild = Function.prototype.call.bind(Node.prototype.appendChild);
const safeRemoveChild = Function.prototype.call.bind(Node.prototype.removeChild);
const safeRemoveNode = typeof Element.prototype.remove === "function"
	? Function.prototype.call.bind(Element.prototype.remove)
	: null;
const pageDataCallTimes = [];
let pageDataActiveCalls = 0;
const pageCallTimes = [];
let pageCallActiveCalls = 0;

function randomRequestId() {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	if (
		typeof globalThis.crypto?.getRandomValues === "function" &&
		typeof Uint8Array === "function"
	) {
		const bytes = new Uint8Array(16);
		globalThis.crypto.getRandomValues(bytes);
		return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function pageDataByteLength(value) {
	const text = String(value ?? "");
	if (pageDataTextEncoder) {
		return pageDataTextEncoder.encode(text).byteLength;
	}
	return text.length * 2;
}

function isPageDataPlainObject(value) {
	if (value == null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function isSafePageDataObjectKey(key) {
	return (
		key !== "__proto__" &&
		key !== "prototype" &&
		key !== "constructor"
	);
}

function reservePageDataCall() {
	const now = Date.now();
	while (
		pageDataCallTimes.length &&
		now - pageDataCallTimes[0] >= PAGE_DATA_RATE_WINDOW_MS
	) {
		pageDataCallTimes.shift();
	}
	if (pageDataCallTimes.length >= PAGE_DATA_MAX_CALLS_PER_WINDOW) {
		throw new Error("getPageData rate limit exceeded");
	}
	if (pageDataActiveCalls >= PAGE_DATA_MAX_ACTIVE_CALLS) {
		throw new Error("getPageData has too many active calls");
	}
	pageDataCallTimes.push(now);
	pageDataActiveCalls += 1;
	return () => {
		if (pageDataActiveCalls > 0) {
			pageDataActiveCalls -= 1;
		}
	};
}

function reservePageCall() {
	const now = Date.now();
	while (
		pageCallTimes.length &&
		now - pageCallTimes[0] >= PAGE_CALL_RATE_WINDOW_MS
	) {
		pageCallTimes.shift();
	}
	if (pageCallTimes.length >= PAGE_CALL_MAX_CALLS_PER_WINDOW) {
		throw new Error("page.call rate limit exceeded");
	}
	if (pageCallActiveCalls >= PAGE_CALL_MAX_ACTIVE_CALLS) {
		throw new Error("page.call has too many active calls");
	}
	pageCallTimes.push(now);
	pageCallActiveCalls += 1;
	return () => {
		if (pageCallActiveCalls > 0) {
			pageCallActiveCalls -= 1;
		}
	};
}

function normalizePageDataSerializableValue(
	value,
	depth = 0,
	seen = new WeakSet(),
) {
	if (depth > PAGE_DATA_MAX_DEPTH) {
		throw new Error("getPageData value exceeds maximum depth");
	}
	if (value === null) return null;
	switch (typeof value) {
		case "string":
		case "boolean":
			return value;
		case "number":
			if (!Number.isFinite(value)) {
				throw new Error("getPageData numeric value must be finite");
			}
			return value;
		case "object":
			break;
		default:
			throw new Error("getPageData value type is not supported");
	}
	if (seen.has(value)) {
		throw new Error("getPageData value must not contain cycles");
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > PAGE_DATA_MAX_ARRAY_LENGTH) {
				throw new Error("getPageData array is too large");
			}
			return value.map((item) =>
				normalizePageDataSerializableValue(item, depth + 1, seen),
			);
		}
		if (!isPageDataPlainObject(value)) {
			throw new Error("getPageData object must be plain");
		}
		const result = Object.create(null);
		const entries = Object.entries(value);
		if (entries.length > PAGE_DATA_MAX_OBJECT_KEYS) {
			throw new Error("getPageData object has too many keys");
		}
		for (const [key, entryValue] of entries) {
			if (key.length > PAGE_DATA_MAX_OBJECT_KEY_LENGTH) {
				throw new Error("getPageData object key is too long");
			}
			if (!isSafePageDataObjectKey(key)) {
				throw new Error("getPageData object key is not allowed");
			}
			result[key] = normalizePageDataSerializableValue(
				entryValue,
				depth + 1,
				seen,
			);
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

function normalizePageCallOperation(operation) {
	if (typeof operation !== "string" || !operation.length) {
		throw new Error("page.call operation must be a non-empty string");
	}
	if (operation.length > PAGE_CALL_MAX_OPERATION_LENGTH) {
		throw new Error("page.call operation is too long");
	}
	if (!PAGE_CALL_ALLOWED_OPERATIONS.has(operation)) {
		throw new Error(`Unsupported page operation: ${operation}`);
	}
	return operation;
}

function normalizePageCallSelector(selector) {
	if (typeof selector !== "string" || !selector.trim()) {
		throw new Error("page.call selector must be a non-empty string");
	}
	if (selector.length > PAGE_CALL_MAX_SELECTOR_LENGTH) {
		throw new Error("page.call selector is too long");
	}
	return selector;
}

function normalizePageCallBoolean(value, label) {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a boolean`);
	}
	return value;
}

function normalizePageCallNumber(value, label) {
	if (!Number.isFinite(value)) {
		throw new Error(`${label} must be a finite number`);
	}
	return value;
}

function normalizePageCallString(value, label) {
	if (typeof value !== "string") {
		throw new Error(`${label} must be a string`);
	}
	if (value.length > PAGE_CALL_MAX_EVENT_STRING_LENGTH) {
		throw new Error(`${label} is too long`);
	}
	return value;
}

function normalizePageCallEventSpec(spec) {
	const normalizedSpec = normalizePageDataSerializableValue(spec);
	if (!isPageDataPlainObject(normalizedSpec)) {
		throw new Error("page.call event spec must be a plain object");
	}
	const hasOwn = (key) =>
		Object.prototype.hasOwnProperty.call(normalizedSpec, key);
	const kind = hasOwn("kind")
		? normalizePageCallString(normalizedSpec.kind, "page.call event kind")
		: "event";
	if (!PAGE_CALL_ALLOWED_EVENT_KINDS.has(kind)) {
		throw new Error(`page.call unsupported event kind: ${kind}`);
	}
	const type = normalizePageCallString(
		normalizedSpec.type,
		"page.call event type",
	);
	if (!type.length) {
		throw new Error("page.call event type must not be empty");
	}
	if (type.length > PAGE_CALL_MAX_EVENT_TYPE_LENGTH) {
		throw new Error("page.call event type is too long");
	}
	const allowedKeys = new Set(["kind", "type", "bubbles", "cancelable", "composed"]);
	if (kind === "custom") {
		allowedKeys.add("detail");
	} else if (kind === "mouse") {
		for (const key of [
			"button",
			"buttons",
			"clientX",
			"clientY",
			"screenX",
			"screenY",
			"ctrlKey",
			"shiftKey",
			"altKey",
			"metaKey",
		]) {
			allowedKeys.add(key);
		}
	} else if (kind === "keyboard") {
		for (const key of [
			"key",
			"code",
			"location",
			"repeat",
			"ctrlKey",
			"shiftKey",
			"altKey",
			"metaKey",
		]) {
			allowedKeys.add(key);
		}
	} else if (kind === "input") {
		for (const key of ["data", "inputType", "isComposing"]) {
			allowedKeys.add(key);
		}
	}
	for (const key of Object.keys(normalizedSpec)) {
		if (!allowedKeys.has(key)) {
			throw new Error(`page.call event spec key is not allowed: ${key}`);
		}
	}
	const result = Object.create(null);
	result.kind = kind;
	result.type = type;
	if (hasOwn("bubbles")) {
		result.bubbles = normalizePageCallBoolean(
			normalizedSpec.bubbles,
			"page.call event bubbles",
		);
	}
	if (hasOwn("cancelable")) {
		result.cancelable = normalizePageCallBoolean(
			normalizedSpec.cancelable,
			"page.call event cancelable",
		);
	}
	if (hasOwn("composed")) {
		result.composed = normalizePageCallBoolean(
			normalizedSpec.composed,
			"page.call event composed",
		);
	}
	if (kind === "custom" && hasOwn("detail")) {
		result.detail = normalizedSpec.detail;
	}
	if (kind === "mouse") {
		for (const key of ["button", "buttons", "clientX", "clientY", "screenX", "screenY"]) {
			if (hasOwn(key)) {
				result[key] = normalizePageCallNumber(
					normalizedSpec[key],
					`page.call event ${key}`,
				);
			}
		}
		for (const key of ["ctrlKey", "shiftKey", "altKey", "metaKey"]) {
			if (hasOwn(key)) {
				result[key] = normalizePageCallBoolean(
					normalizedSpec[key],
					`page.call event ${key}`,
				);
			}
		}
	}
	if (kind === "keyboard") {
		for (const key of ["key", "code"]) {
			if (hasOwn(key)) {
				result[key] = normalizePageCallString(
					normalizedSpec[key],
					`page.call event ${key}`,
				);
			}
		}
		if (hasOwn("location")) {
			result.location = normalizePageCallNumber(
				normalizedSpec.location,
				"page.call event location",
			);
		}
		for (const key of ["repeat", "ctrlKey", "shiftKey", "altKey", "metaKey"]) {
			if (hasOwn(key)) {
				result[key] = normalizePageCallBoolean(
					normalizedSpec[key],
					`page.call event ${key}`,
				);
			}
		}
	}
	if (kind === "input") {
		for (const key of ["data", "inputType"]) {
			if (hasOwn(key)) {
				result[key] = normalizePageCallString(
					normalizedSpec[key],
					`page.call event ${key}`,
				);
			}
		}
		if (hasOwn("isComposing")) {
			result.isComposing = normalizePageCallBoolean(
				normalizedSpec.isComposing,
				"page.call event isComposing",
			);
		}
	}
	return result;
}

function normalizePageCallArgs(operation, args) {
	if (!Array.isArray(args)) {
		throw new Error("page.call arguments must be an array");
	}
	switch (operation) {
		case "dom.queryText":
		case "dom.click":
			if (args.length !== 1) {
				throw new Error(`page.call ${operation} expects exactly 1 argument`);
			}
			return [normalizePageCallSelector(args[0])];
		case "event.dispatch":
			if (args.length !== 2) {
				throw new Error("page.call event.dispatch expects exactly 2 arguments");
			}
			return [
				normalizePageCallSelector(args[0]),
				normalizePageCallEventSpec(args[1]),
			];
		default:
			throw new Error(`Unsupported page operation: ${operation}`);
	}
}

function runSerializedPageTask({
	buildScript,
	defaultErrorMessage,
	maxResultBytes,
	release,
	requestId,
	responseEventPrefix,
	timeoutMessage,
	timeoutMs,
}) {
	const responseEvent = `__userscripts_${responseEventPrefix}_${randomRequestId()}__`;
	return new Promise((resolve, reject) => {
		let host = null;
		let settled = false;
		let timeoutId;
		let releaseCall = release;
		const cleanup = () => {
			safePageRemoveEventListener(document, responseEvent, onResponse);
			clearTimeout(timeoutId);
			if (releaseCall) {
				releaseCall();
				releaseCall = null;
			}
			try {
				if (host && safeRemoveNode) {
					safeRemoveNode(host);
				} else if (host?.parentNode) {
					safeRemoveChild(host.parentNode, host);
				}
			} catch {
				// Ignore cleanup failures.
			}
		};
		const onResponse = (event) => {
			if (settled || typeof event.detail !== "string") return;
			try {
				if (pageDataByteLength(event.detail) > maxResultBytes) {
					return;
				}
				const payload = JSON.parse(event.detail);
				if (
					!payload ||
					typeof payload !== "object" ||
					Array.isArray(payload) ||
					payload.id !== requestId ||
					typeof payload.ok !== "boolean"
				) {
					return;
				}
				let normalizedValue;
				if (payload.ok === true) {
					normalizedValue = normalizePageDataSerializableValue(payload.value);
				} else if (typeof payload.error !== "string") {
					return;
				}
				settled = true;
				cleanup();
				if (payload.ok === true) {
					resolve(normalizedValue);
					return;
				}
				reject(new Error(payload?.error || defaultErrorMessage));
			} catch {
				// Ignore malformed or corrupted response events and keep waiting.
			}
		};
		try {
			safePageAddEventListener(document, responseEvent, onResponse);
			timeoutId = setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new Error(timeoutMessage));
			}, timeoutMs);
			host = safeCreateElement(document, "div");
			host.style.display = "none";
			const shadowRoot = safeAttachShadow(host, { mode: "closed" });
			const tag = safeCreateElement(document, "script");
			tag.textContent = buildScript(responseEvent);
			safeAppendChild(shadowRoot, tag);
			safeAppendChild(
				document.body ?? document.head ?? document.documentElement,
				host,
			);
		} catch (error) {
			settled = true;
			cleanup();
			reject(error);
		}
	});
}

function buildPageDataScript(responseEvent, requestId, extractorSource, argsJson) {
	return `(() => {
	const __US_RESPONSE_EVENT__ = ${JSON.stringify(responseEvent)};
	const __US_REQUEST_ID__ = ${JSON.stringify(requestId)};
	const __US_ARGS__ = ${argsJson};
	const __US_MAX_DEPTH__ = ${PAGE_DATA_MAX_DEPTH};
	const __US_MAX_ARRAY_LENGTH__ = ${PAGE_DATA_MAX_ARRAY_LENGTH};
	const __US_MAX_OBJECT_KEYS__ = ${PAGE_DATA_MAX_OBJECT_KEYS};
	const __US_MAX_OBJECT_KEY_LENGTH__ = ${PAGE_DATA_MAX_OBJECT_KEY_LENGTH};
	const __US_MAX_RESULT_BYTES__ = ${PAGE_DATA_MAX_RESULT_BYTES};
	const __US_byteLength = (value) => {
		const text = String(value ?? "");
		if (typeof TextEncoder === "function") {
			return new TextEncoder().encode(text).byteLength;
		}
		return text.length * 2;
	};
	const __US_isPlainObject = (value) => {
		if (value == null || typeof value !== "object" || Array.isArray(value)) {
			return false;
		}
		try {
			const prototype = Object.getPrototypeOf(value);
			return prototype === Object.prototype || prototype === null;
		} catch {
			return false;
		}
	};
	const __US_isSafeKey = (key) =>
		key !== "__proto__" &&
		key !== "prototype" &&
		key !== "constructor";
	const __US_normalize = (value, depth = 0, seen = new WeakSet()) => {
		if (depth > __US_MAX_DEPTH__) {
			throw new Error("Page data result exceeds maximum depth");
		}
		if (value === null) return null;
		switch (typeof value) {
			case "string":
			case "boolean":
				return value;
			case "number":
				if (!Number.isFinite(value)) {
					throw new Error("Page data result contains a non-finite number");
				}
				return value;
			case "object":
				break;
			default:
				throw new Error("Page data result contains an unsupported type");
		}
		if (seen.has(value)) {
			throw new Error("Page data result contains a cycle");
		}
		seen.add(value);
		try {
			if (Array.isArray(value)) {
				if (value.length > __US_MAX_ARRAY_LENGTH__) {
					throw new Error("Page data result array is too large");
				}
				return value.map((item) => __US_normalize(item, depth + 1, seen));
			}
			if (!__US_isPlainObject(value)) {
				throw new Error("Page data result object must be plain");
			}
			const entries = Object.entries(value);
			if (entries.length > __US_MAX_OBJECT_KEYS__) {
				throw new Error("Page data result object has too many keys");
			}
			const result = Object.create(null);
			for (const [key, entryValue] of entries) {
				if (key.length > __US_MAX_OBJECT_KEY_LENGTH__) {
					throw new Error("Page data result object key is too long");
				}
				if (!__US_isSafeKey(key)) {
					throw new Error("Page data result object key is not allowed");
				}
				result[key] = __US_normalize(entryValue, depth + 1, seen);
			}
			return result;
		} finally {
			seen.delete(value);
		}
	};
	const __US_send = (payload) => {
		let json;
		try {
			json = JSON.stringify({
				id: __US_REQUEST_ID__,
				...payload,
			});
		} catch (error) {
			json = JSON.stringify({
				id: __US_REQUEST_ID__,
				ok: false,
				error: String(error?.message || error),
			});
		}
		if (__US_byteLength(json) > __US_MAX_RESULT_BYTES__) {
			json = JSON.stringify({
				id: __US_REQUEST_ID__,
				ok: false,
				error: "Page data result is too large",
			});
		}
		document.dispatchEvent(new CustomEvent(__US_RESPONSE_EVENT__, {
			detail: json,
		}));
	};
	try {
		const __US_extractor = (${extractorSource});
		Promise.resolve(__US_extractor(...__US_ARGS__)).then(
			(value) => {
				try {
					__US_send({
						ok: true,
						value: __US_normalize(value),
					});
				} catch (error) {
					__US_send({
						ok: false,
						error: String(error?.message || error),
					});
				}
			},
			(error) => {
				__US_send({
					ok: false,
					error: String(error?.message || error),
				});
			},
		);
	} catch (error) {
		__US_send({
			ok: false,
			error: String(error?.message || error),
		});
	}
})();`;
}

function buildPageCallScript(responseEvent, requestId, operation, argsJson) {
	return `(() => {
	const __US_RESPONSE_EVENT__ = ${JSON.stringify(responseEvent)};
	const __US_REQUEST_ID__ = ${JSON.stringify(requestId)};
	const __US_OPERATION__ = ${JSON.stringify(operation)};
	const __US_ARGS__ = ${argsJson};
	const __US_MAX_DEPTH__ = ${PAGE_DATA_MAX_DEPTH};
	const __US_MAX_ARRAY_LENGTH__ = ${PAGE_DATA_MAX_ARRAY_LENGTH};
	const __US_MAX_OBJECT_KEYS__ = ${PAGE_DATA_MAX_OBJECT_KEYS};
	const __US_MAX_OBJECT_KEY_LENGTH__ = ${PAGE_DATA_MAX_OBJECT_KEY_LENGTH};
	const __US_MAX_RESULT_BYTES__ = ${PAGE_CALL_MAX_RESULT_BYTES};
	const __US_byteLength = (value) => {
		const text = String(value ?? "");
		if (typeof TextEncoder === "function") {
			return new TextEncoder().encode(text).byteLength;
		}
		return text.length * 2;
	};
	const __US_isPlainObject = (value) => {
		if (value == null || typeof value !== "object" || Array.isArray(value)) {
			return false;
		}
		try {
			const prototype = Object.getPrototypeOf(value);
			return prototype === Object.prototype || prototype === null;
		} catch {
			return false;
		}
	};
	const __US_isSafeKey = (key) =>
		key !== "__proto__" &&
		key !== "prototype" &&
		key !== "constructor";
	const __US_normalize = (value, depth = 0, seen = new WeakSet()) => {
		if (depth > __US_MAX_DEPTH__) {
			throw new Error("Page call result exceeds maximum depth");
		}
		if (value === null) return null;
		switch (typeof value) {
			case "string":
			case "boolean":
				return value;
			case "number":
				if (!Number.isFinite(value)) {
					throw new Error("Page call result contains a non-finite number");
				}
				return value;
			case "object":
				break;
			default:
				throw new Error("Page call result contains an unsupported type");
		}
		if (seen.has(value)) {
			throw new Error("Page call result contains a cycle");
		}
		seen.add(value);
		try {
			if (Array.isArray(value)) {
				if (value.length > __US_MAX_ARRAY_LENGTH__) {
					throw new Error("Page call result array is too large");
				}
				return value.map((item) => __US_normalize(item, depth + 1, seen));
			}
			if (!__US_isPlainObject(value)) {
				throw new Error("Page call result object must be plain");
			}
			const entries = Object.entries(value);
			if (entries.length > __US_MAX_OBJECT_KEYS__) {
				throw new Error("Page call result object has too many keys");
			}
			const result = Object.create(null);
			for (const [key, entryValue] of entries) {
				if (key.length > __US_MAX_OBJECT_KEY_LENGTH__) {
					throw new Error("Page call result object key is too long");
				}
				if (!__US_isSafeKey(key)) {
					throw new Error("Page call result object key is not allowed");
				}
				result[key] = __US_normalize(entryValue, depth + 1, seen);
			}
			return result;
		} finally {
			seen.delete(value);
		}
	};
	const __US_send = (payload) => {
		let json;
		try {
			json = JSON.stringify({
				id: __US_REQUEST_ID__,
				...payload,
			});
		} catch (error) {
			json = JSON.stringify({
				id: __US_REQUEST_ID__,
				ok: false,
				error: String(error?.message || error),
			});
		}
		if (__US_byteLength(json) > __US_MAX_RESULT_BYTES__) {
			json = JSON.stringify({
				id: __US_REQUEST_ID__,
				ok: false,
				error: "page.call result is too large",
			});
		}
		document.dispatchEvent(new CustomEvent(__US_RESPONSE_EVENT__, {
			detail: json,
		}));
	};
	const __US_selectTarget = (selector) => {
		try {
			return document.querySelector(selector);
		} catch (error) {
			throw new Error(String(error?.message || error));
		}
	};
	const __US_buildEvent = (spec) => {
		const init = {};
		for (const key of ["bubbles", "cancelable", "composed"]) {
			if (Object.prototype.hasOwnProperty.call(spec, key)) {
				init[key] = spec[key];
			}
		}
		switch (spec.kind) {
			case "custom":
				if (Object.prototype.hasOwnProperty.call(spec, "detail")) {
					init.detail = spec.detail;
				}
				return new CustomEvent(spec.type, init);
			case "mouse":
				for (const key of [
					"button",
					"buttons",
					"clientX",
					"clientY",
					"screenX",
					"screenY",
					"ctrlKey",
					"shiftKey",
					"altKey",
					"metaKey",
				]) {
					if (Object.prototype.hasOwnProperty.call(spec, key)) {
						init[key] = spec[key];
					}
				}
				return new MouseEvent(spec.type, init);
			case "keyboard":
				for (const key of [
					"key",
					"code",
					"location",
					"repeat",
					"ctrlKey",
					"shiftKey",
					"altKey",
					"metaKey",
				]) {
					if (Object.prototype.hasOwnProperty.call(spec, key)) {
						init[key] = spec[key];
					}
				}
				return new KeyboardEvent(spec.type, init);
			case "input":
				for (const key of ["data", "inputType", "isComposing"]) {
					if (Object.prototype.hasOwnProperty.call(spec, key)) {
						init[key] = spec[key];
					}
				}
				return typeof InputEvent === "function"
					? new InputEvent(spec.type, init)
					: new Event(spec.type, init);
			default:
				return new Event(spec.type, init);
		}
	};
	const __US_OPERATIONS__ = {
		"dom.queryText": (selector) => {
			const target = __US_selectTarget(selector);
			return target ? String(target.textContent ?? "") : null;
		},
		"dom.click": (selector) => {
			const target = __US_selectTarget(selector);
			if (!target) return false;
			if (typeof target.click === "function") {
				target.click();
			} else {
				target.dispatchEvent(new MouseEvent("click", {
					bubbles: true,
					cancelable: true,
					composed: true,
				}));
			}
			return true;
		},
		"event.dispatch": (selector, spec) => {
			const target = __US_selectTarget(selector);
			if (!target) return false;
			return target.dispatchEvent(__US_buildEvent(spec));
		},
	};
	try {
		const __US_operation = __US_OPERATIONS__[__US_OPERATION__];
		if (typeof __US_operation !== "function") {
			throw new Error("Unsupported page operation");
		}
		Promise.resolve(__US_operation(...__US_ARGS__)).then(
			(value) => {
				try {
					__US_send({
						ok: true,
						value: __US_normalize(value),
					});
				} catch (error) {
					__US_send({
						ok: false,
						error: String(error?.message || error),
					});
				}
			},
			(error) => {
				__US_send({
					ok: false,
					error: String(error?.message || error),
				});
			},
		);
	} catch (error) {
		__US_send({
			ok: false,
			error: String(error?.message || error),
		});
	}
})();`;
}

async function getPageData(extractor, ...args) {
	if (typeof extractor !== "function") {
		return Promise.reject(new Error("getPageData requires a function extractor"));
	}
	let extractorSource;
	try {
		extractorSource = safeFunctionToString(extractor);
	} catch (error) {
		return Promise.reject(error);
	}
	if (pageDataByteLength(extractorSource) > PAGE_DATA_MAX_EXTRACTOR_BYTES) {
		return Promise.reject(new Error("getPageData extractor is too large"));
	}
	const normalizedArgs = normalizePageDataSerializableValue(args);
	const argsJson = JSON.stringify(normalizedArgs);
	if (pageDataByteLength(argsJson) > PAGE_DATA_MAX_ARGS_BYTES) {
		return Promise.reject(new Error("getPageData arguments are too large"));
	}
	let releasePageDataCall;
	try {
		releasePageDataCall = reservePageDataCall();
	} catch (error) {
		return Promise.reject(error);
	}
	const requestId = randomRequestId();
	return runSerializedPageTask({
		buildScript: (responseEvent) =>
			buildPageDataScript(responseEvent, requestId, extractorSource, argsJson),
		defaultErrorMessage: "getPageData failed",
		maxResultBytes: PAGE_DATA_MAX_RESULT_BYTES,
		release: releasePageDataCall,
		requestId,
		responseEventPrefix: "page_data_response",
		timeoutMessage: "getPageData timed out",
		timeoutMs: PAGE_DATA_TIMEOUT_MS,
	});
}

async function pageCall(operation, ...args) {
	let normalizedOperation;
	try {
		normalizedOperation = normalizePageCallOperation(operation);
	} catch (error) {
		return Promise.reject(error);
	}
	let normalizedArgs;
	try {
		normalizedArgs = normalizePageCallArgs(normalizedOperation, args);
	} catch (error) {
		return Promise.reject(error);
	}
	const argsJson = JSON.stringify(normalizedArgs);
	if (pageDataByteLength(argsJson) > PAGE_CALL_MAX_ARGS_BYTES) {
		return Promise.reject(new Error("page.call arguments are too large"));
	}
	let releasePageCall;
	try {
		releasePageCall = reservePageCall();
	} catch (error) {
		return Promise.reject(error);
	}
	const requestId = randomRequestId();
	return runSerializedPageTask({
		buildScript: (responseEvent) =>
			buildPageCallScript(
				responseEvent,
				requestId,
				normalizedOperation,
				argsJson,
			),
		defaultErrorMessage: "page.call failed",
		maxResultBytes: PAGE_CALL_MAX_RESULT_BYTES,
		release: releasePageCall,
		requestId,
		responseEventPrefix: "page_call_response",
		timeoutMessage: "page.call timed out",
		timeoutMs: PAGE_CALL_TIMEOUT_MS,
	});
}

function getXhrContext(value) {
	return value != null && typeof value === "object" ? value : {};
}

function normalizeConnectRules(value) {
	if (Array.isArray(value)) {
		return value
			.map((item) => (typeof item === "string" ? item.trim() : ""))
			.filter(Boolean);
	}
	if (typeof value === "string" && value.trim()) {
		return [value.trim()];
	}
	return [];
}

function normalizeXhrMethod(value) {
	const method = String(value || "GET").toUpperCase();
	if (!XHR_ALLOWED_METHODS.has(method)) {
		throw new Error("xhr unsupported method");
	}
	return method;
}

function normalizeXhrResponseType(value) {
	const responseType = typeof value === "string" ? value : "";
	return XHR_ALLOWED_RESPONSE_TYPES.has(responseType) ? responseType : "";
}

function normalizeXhrTimeout(value) {
	const timeout = Number(value);
	if (!Number.isFinite(timeout) || timeout <= 0) return 0;
	return Math.min(Math.floor(timeout), XHR_MAX_TIMEOUT_MS);
}

function parseXhrUrl(url, baseHref = globalThis.location?.href) {
	const parsedUrl = new URL(String(url || ""), baseHref);
	if (!["http:", "https:"].includes(parsedUrl.protocol)) {
		throw new Error("xhr invalid url protocol");
	}
	return parsedUrl;
}

function sanitizeXhrHeaders(input) {
	const headers = {};
	if (input == null) return headers;
	if (typeof input !== "object" || Array.isArray(input)) {
		throw new Error("xhr invalid headers");
	}
	let headerCount = 0;
	for (const [rawName, rawValue] of Object.entries(input)) {
		const name = String(rawName || "").trim().toLowerCase();
		if (!name) continue;
		if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
		if (
			XHR_FORBIDDEN_HEADERS.has(name) ||
			XHR_FORBIDDEN_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
		) {
			continue;
		}
		const value = String(rawValue);
		if (value.length > XHR_MAX_HEADER_VALUE_LENGTH || /[\r\n]/.test(value)) {
			throw new Error("xhr invalid header value");
		}
		headerCount += 1;
		if (headerCount > XHR_MAX_HEADER_COUNT) {
			throw new Error("xhr too many headers");
		}
		headers[name] = value;
	}
	return headers;
}

function isConnectRuleMatch(parsedUrl, rule, pageOrigin) {
	const normalizedRule = String(rule || "").trim().toLowerCase();
	if (!normalizedRule) return false;
	if (normalizedRule === "*") return true;
	if (normalizedRule === "self") {
		return Boolean(pageOrigin) && parsedUrl.origin === pageOrigin;
	}
	if (normalizedRule.startsWith("*.")) {
		const suffix = normalizedRule.slice(1);
		const hostname = parsedUrl.hostname.toLowerCase();
		return hostname.endsWith(suffix) && hostname !== suffix.slice(1);
	}
	if (normalizedRule.includes("://")) {
		try {
			return parsedUrl.origin === new URL(normalizedRule).origin;
		} catch {
			return false;
		}
	}
	return parsedUrl.hostname.toLowerCase() === normalizedRule;
}

function assertXhrConnectAllowed(parsedUrl, requestContext) {
	const pageOrigin =
		typeof requestContext.US_pageOrigin === "string"
			? requestContext.US_pageOrigin
			: "";
	const connectRules = normalizeConnectRules(requestContext.US_connect);
	if (connectRules.length) {
		if (!connectRules.some((rule) => isConnectRuleMatch(parsedUrl, rule, pageOrigin))) {
			throw new Error("xhr url not allowed by @connect");
		}
		return;
	}
	if (
		requestContext.US_hasConnectMetadata === true ||
		requestContext.US_enforceSameOriginWithoutConnect === true
	) {
		if (!pageOrigin || parsedUrl.origin !== pageOrigin) {
			throw new Error("xhr cross-origin request requires @connect");
		}
	}
}

async function openInTab(url, openInBackground = false) {
	let parsedUrl;
	try {
		parsedUrl = new URL(url, globalThis.location?.href);
	} catch (error) {
		return Promise.reject(error);
	}
	if (["javascript:", "data:"].includes(parsedUrl.protocol)) {
		return Promise.reject(new Error("openInTab invalid url protocol"));
	}
	return sendMessageProxy({
		name: "API_OPEN_TAB",
		url,
		active: !openInBackground,
	});
}

async function closeTab(tabId) {
	return sendMessageProxy({ name: "API_CLOSE_TAB", tabId });
}

async function getTab() {
	return sendMessageProxy({ name: "API_GET_TAB" });
}

async function saveTab(tabObj) {
	if (tabObj == null) return Promise.reject(new Error("saveTab invalid arg"));
	return sendMessageProxy({ name: "API_SAVE_TAB", tabObj });
}

async function addStyle(css) {
	if (typeof css !== "string" || !css.length) {
		return Promise.reject(new Error("addStyle invalid css arg"));
	}
	return sendMessageProxy({ name: "API_ADD_STYLE", css });
}

async function setClipboard(clipboardData, type) {
	return sendMessageProxy({
		name: "API_SET_CLIPBOARD",
		clipboardData,
		type,
	});
}

/**
 * Restore `response.response` to required `responseType`
 * @param {TypeExtMessages.XHRTransportableResponse} msgResponse
 * @param {TypeExtMessages.XHRResponse} response
 */
function xhrResponseProcessor(msgResponse, response) {
	const res = msgResponse;
	/**
	 * only include responseXML when needed
	 * NOTE: Only add implementation at this time, not enable, to avoid
	 * unnecessary calculations, and this legacy default behavior is not
	 * recommended, users should explicitly use `responseType: "document"`
	 * to obtain it.
	if (res.responseType === "" && typeof res.response === "string") {
		const mimeTypes = [
			"text/xml",
			"application/xml",
			"application/xhtml+xml",
			"image/svg+xml",
		];
		for (const mimeType of mimeTypes) {
			if (res.contentType.includes(mimeType)) {
				const parser = new DOMParser();
				res.responseXML = parser.parseFromString(res.response, "text/xml");
				break;
			}
		}
	}
	*/
	if (res.responseType === "arraybuffer" && Array.isArray(res.response)) {
		// arraybuffer responses had their data converted in background
		// convert it back to arraybuffer
		try {
			response.response = new Uint8Array(res.response).buffer;
		} catch (err) {
			console.error("error parsing xhr arraybuffer", err);
		}
	}
	if (res.responseType === "blob" && Array.isArray(res.response)) {
		// blob responses had their data converted in background
		// convert it back to blob
		try {
			const typedArray = new Uint8Array(res.response);
			const type = res.contentType ?? "";
			response.response = new Blob([typedArray], { type });
		} catch (err) {
			console.error("error parsing xhr blob", err);
		}
	}
	if (res.responseType === "document" && typeof res.response === "string") {
		// document responses had their data converted in background
		// convert it back to document
		try {
			const parser = new DOMParser();
			const mimeType = res.contentType.includes("text/html")
				? "text/html"
				: "text/xml";
			response.response = parser.parseFromString(res.response, mimeType);
			response.responseXML = response.response;
		} catch (err) {
			console.error("error parsing xhr document", err);
		}
	}
}

/**
 * Process data into a transportable object
 * @param {Parameters<XMLHttpRequest["send"]>[0]} data
 * @returns {Promise<TypeExtMessages.XHRProcessedData>}
 */
async function xhrDataProcessor(data) {
	if (typeof data === "undefined") return undefined;
	if (typeof data === "string") {
		return { data, type: "Text" };
	}
	if (data instanceof Document) {
		if (data instanceof XMLDocument) {
			try {
				return {
					data: new XMLSerializer().serializeToString(data),
					type: "Document",
					mime: data.contentType || "text/xml",
				};
			} catch (error) {
				console.error(
					"XML serialization failed, the data will be omitted",
					error,
				);
			}
		} else {
			let html = data.documentElement.outerHTML;
			if (data.doctype) {
				html = `<!doctype ${data.doctype.name}>` + html;
			}
			return {
				data: html,
				type: "Document",
				mime: data.contentType || "text/html",
			};
		}
	}
	if (data instanceof Blob) {
		try {
			const buffer = await data.arrayBuffer();
			return {
				data: Array.from(new Uint8Array(buffer)),
				type: "Blob",
				mime: data.type,
			};
		} catch (error) {
			throw Error("Document serialization failed, the data will be omitted", {
				cause: error,
			});
		}
	}
	if (data instanceof ArrayBuffer) {
		return {
			data: Array.from(new Uint8Array(data)),
			type: "ArrayBuffer",
		};
	}
	if (ArrayBuffer.isView(data)) {
		return {
			data: Array.from(
				new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
			),
			type: "ArrayBufferView",
		};
	}
	if (data instanceof FormData) {
		/** @type {TypeExtMessages.XHRProcessedFormData} */
		const entries = [];
		for (const [k, v] of data.entries()) {
			if (typeof v === "string") {
				entries.push([k, v]);
				continue;
			} else {
				const buffer = await v.arrayBuffer();
				entries.push([
					k,
					{
						data: Array.from(new Uint8Array(buffer)),
						lastModified: v.lastModified,
						name: v.name,
						mime: v.type,
					},
				]);
			}
		}
		return { data: entries, type: "FormData" };
	}
	if (data instanceof URLSearchParams) {
		return { data: data.toString(), type: "URLSearchParams" };
	}
	throw Error("Unexpected data type, the data will be omitted");
}

/**
 * @param {Object} details
 * @param {Object} control
 * @returns {Promise<void>}
 */
async function xhr(details, control) {
	const requestContext = getXhrContext(this);
	if (details == null || typeof details !== "object" || Array.isArray(details)) {
		throw new Error("xhr invalid details arg");
	}
	if (!details.url) {
		throw new Error("xhr details missing url key");
	}
	const parsedUrl = parseXhrUrl(details.url, globalThis.location?.href);
	assertXhrConnectAllowed(parsedUrl, requestContext);
	// define control method, will be replaced after port is established
	control.abort = () => console.error("xhr has not yet been initialized");
	// depreciation notice
	if (details.binary) {
		console.warn(
			"Please make sure your xhr `data` is a binary-string since you have set the `binary` true, however this legacy format is no longer recommended.",
			"The `binary` key is deprecated and will be removed in the future, use binary data objects such as `Blob`, `ArrayBuffer`, `TypedArray`, etc. instead.",
		);
	}
	// can not send details (func, blob, etc.) through message
	// construct a new processed object send to background page
	/** @type {TypeExtMessages.XHRTransportableDetails} */
	const detailsParsed = {
		binary: Boolean(details.binary),
		data: undefined,
		headers: sanitizeXhrHeaders(details.headers),
		method: normalizeXhrMethod(details.method),
		overrideMimeType:
			typeof details.overrideMimeType === "string" ? details.overrideMimeType : "",
		password: typeof details.password === "string" ? details.password : "",
		responseType: normalizeXhrResponseType(details.responseType),
		timeout: normalizeXhrTimeout(details.timeout),
		url: parsedUrl.href,
		user: typeof details.user === "string" ? details.user : "",
		hasHandlers: {},
		hasUploadHandlers: {},
	};
	// preprocess data key
	try {
		detailsParsed.data = await xhrDataProcessor(details.data);
	} catch (error) {
		console.error(error);
	}
	// preprocess handlers
	/**
	 * Record the handlers existing in details to a new object
	 * to avoid modifying the original object, and to prevent
	 * the original object from being changed by user scripts
	 * @type {TypeExtMessages.XHRHandlersObj}
	 */
	const handlers = {};
	/** @type {TypeExtMessages.XHRHandlers} */
	const XHRHandlers = [
		"onreadystatechange",
		"onloadstart",
		"onprogress",
		"onabort",
		"onerror",
		"onload",
		"ontimeout",
		"onloadend",
	];
	for (const handler of XHRHandlers) {
		// check which handlers are included in the original details object
		if (
			handler in XMLHttpRequest.prototype &&
			typeof details[handler] === "function"
		) {
			// add a bool to indicate if event listeners should be attached
			detailsParsed.hasHandlers[handler] = true;
			// record to the new object
			handlers[handler] = details[handler];
		}
	}
	// preprocess upload handlers
	/** @type {TypeExtMessages.XHRUploadHandlersObj} */
	const uploadHandlers = {};
	/** @type {TypeExtMessages.XHRUploadHandlers} */
	const XHRUploadHandlers = [
		"onabort",
		"onerror",
		"onload",
		"onloadend",
		"onloadstart",
		"onprogress",
		"ontimeout",
	];
	if (typeof details.upload === "object") {
		for (const handler of XHRUploadHandlers) {
			if (
				handler in XMLHttpRequestEventTarget.prototype &&
				typeof details.upload[handler] === "function"
			) {
				detailsParsed.hasUploadHandlers[handler] = true;
				uploadHandlers[handler] = details.upload[handler];
			}
		}
	}
	// make sure to listen to XHR.DONE events only once, to avoid processing
	// and transmitting the same response data multiple times
	if (detailsParsed.hasHandlers.onreadystatechange) {
		delete detailsParsed.hasHandlers.onload;
		delete detailsParsed.hasHandlers.onloadend;
	}
	if (detailsParsed.hasHandlers.onload) {
		delete detailsParsed.hasHandlers.onloadend;
	}
	// generate random port name for single xhr
	const xhrPortName = randomRequestId();
	/**
	 * port listener, most of the messaging logic goes here
	 * @type {Parameters<typeof browser.runtime.onConnect.addListener>[0]}
	 * @param {import("../global.d.ts").TypeContentScripts.XHRPort} port
	 */
	const listener = (port) => {
		if (port.name !== xhrPortName) return;
		// handle port messages
		port.onMessage.addListener(async (msg) => {
			const handler = msg.handler;
			// handle upload progress
			if (
				"progress" in msg &&
				detailsParsed.hasUploadHandlers[handler] &&
				typeof uploadHandlers[handler] === "function"
			) {
				// call userscript handler
				uploadHandlers[handler](msg.progress);
				return;
			}
			// handle download events
			if (
				"response" in msg &&
				detailsParsed.hasHandlers[handler] &&
				typeof handlers[handler] === "function"
			) {
				// process xhr response
				/** @type {TypeExtMessages.XHRTransportableResponse} */
				const msgResponse = msg.response;
				/** @type {TypeExtMessages.XHRResponse} */
				const response = msgResponse;
				// only include responseText when needed
				if (["", "text"].includes(response.responseType)) {
					response.responseText = response.response;
				}
				// only process when xhr is complete and data exist
				if (response.readyState === 4 && response.response !== null) {
					xhrResponseProcessor(msgResponse, response);
				}
				// call userscript handler
				handlers[handler](response);
				// call the deleted XHR.DONE handlers above
				if (response.readyState === 4) {
					if (handler === "onreadystatechange") {
						if (typeof handlers.onload === "function") {
							handlers.onload(response);
						}
						if (typeof handlers.onloadend === "function") {
							handlers.onloadend(response);
						}
					} else if (handler === "onload") {
						if (typeof handlers.onloadend === "function") {
							handlers.onloadend(response);
						}
					}
				}
			}
			// all messages received
			if (handler === "onloadend") {
				// tell background it's safe to close port
				port.postMessage({ name: "DISCONNECT" });
			}
		});
		// handle port disconnect and clean tasks
		port.onDisconnect.addListener((p) => {
			if (p?.error) {
				console.error(`port disconnected due to an error: ${p.error.message}`);
			}
			browser.runtime.onConnect.removeListener(listener);
		});
		// fill the method returned to the user script
		control.abort = () => port.postMessage({ name: "ABORT" });
	};
	// wait for the background to establish a port connection
	browser.runtime.onConnect.addListener(listener);
	// pass the basic information to the background through a common message
	const message = {
		name: "API_XHR",
		details: detailsParsed,
		xhrPortName,
	};
	try {
		await sendMessageProxy(message);
	} catch (error) {
		browser.runtime.onConnect.removeListener(listener);
		throw error;
	}
}

function xmlHttpRequest(details) {
	const sourceDetails = details && typeof details === "object" ? details : {};
	let requestControl;
	const control = new Promise((resolve, reject) => {
		requestControl = GM_xmlhttpRequest.call(this, {
			...sourceDetails,
			onload: (response) => {
				sourceDetails.onload?.(response);
				resolve(response);
			},
			onerror: (response) => {
				sourceDetails.onerror?.(response);
				reject(response);
			},
			ontimeout: (response) => {
				sourceDetails.ontimeout?.(response);
				reject(response);
			},
			onabort: (response) => {
				sourceDetails.onabort?.(response);
				reject(response);
			},
		});
	});
	control.abort = () => requestControl?.abort?.();
	return control;
}

function GM_xmlhttpRequest(details) {
	const control = {};
	xhr.call(this, details, control).catch((error) => {
		console.error(error);
		const errorObj = { error: String(error?.message || error) };
		details?.onerror?.(errorObj);
		details?.onloadend?.(errorObj);
	});
	return control;
}

export default {
	setValue,
	getValue,
	listValues,
	deleteValue,
	getPageData,
	page: Object.freeze({
		call: pageCall,
	}),
	openInTab,
	getTab,
	saveTab,
	closeTab,
	addStyle,
	setClipboard,
	// notification,
	// registerMenuCommand,
	// getResourceUrl,
	xmlHttpRequest,
	GM_xmlhttpRequest,
};
