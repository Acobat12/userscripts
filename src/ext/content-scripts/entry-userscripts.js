import USAPI from "./api.js";
import { colors } from "@shared/colors.js";

// code received from background page will be stored in this variable
// code referenced again when strict CSPs block initial injection attempt
let data;
// determines whether strict csp injection has already run (JS only)
let cspFallbackAttempted = false;

// label used to distinguish frames in console
const label = randomLabel();
const usTag = window.self === window.top ? "" : `(${label})`;
const SafeCustomEvent = globalThis.CustomEvent;
const safeAddEventListener = Function.prototype.call.bind(
	EventTarget.prototype.addEventListener,
);
const safeRemoveEventListener = Function.prototype.call.bind(
	EventTarget.prototype.removeEventListener,
);
const safeDispatchEvent = Function.prototype.call.bind(
	EventTarget.prototype.dispatchEvent,
);

function randomLabel() {
	const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	const r = Math.random();
	return a[Math.floor(r * a.length)] + r.toString().slice(5, 6);
}



function pageGrantBridgeEventName(id, type) {
	return `__userscripts_page_grant_bridge_${id}_${type}__`;
}

function pageGrantBridgeRandomId() {
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

function __US_getTypedArrayConstructor(viewName) {
	const typedArrayConstructors = {
		Int8Array,
		Uint8Array,
		Uint8ClampedArray,
		Int16Array,
		Uint16Array,
		Int32Array,
		Uint32Array,
		Float32Array,
		Float64Array,
		BigInt64Array:
			typeof BigInt64Array === "function" ? BigInt64Array : undefined,
		BigUint64Array:
			typeof BigUint64Array === "function" ? BigUint64Array : undefined,
		DataView,
	};
	return typedArrayConstructors[viewName] || Uint8Array;
}

function __US_restoreTypedArrayView(data, viewName) {
	const bytes = new Uint8Array(Array.isArray(data) ? data : []);
	const TypedArrayConstructor = __US_getTypedArrayConstructor(viewName);
	if (TypedArrayConstructor === DataView) {
		return new DataView(bytes.buffer);
	}
	if (
		typeof TypedArrayConstructor?.BYTES_PER_ELEMENT === "number" &&
		TypedArrayConstructor.BYTES_PER_ELEMENT > 0 &&
		bytes.byteLength % TypedArrayConstructor.BYTES_PER_ELEMENT === 0
	) {
		return new TypedArrayConstructor(bytes.buffer);
	}
	return bytes;
}

async function __US_serializeBridgeRequestData(value) {
	if (typeof value === "undefined") return undefined;
	if (typeof value === "string") {
		return { __userscriptsRequestType: "Text", data: value };
	}
	if (
		typeof ReadableStream === "function" &&
		value instanceof ReadableStream
	) {
		throw new Error("ReadableStream is not supported by XMLHttpRequest");
	}
	if (value instanceof Document) {
		if (value instanceof XMLDocument) {
			return {
				__userscriptsRequestType: "Document",
				data: new XMLSerializer().serializeToString(value),
				mimeType: value.contentType || "text/xml",
			};
		}
		let html = value.documentElement?.outerHTML || "";
		if (value.doctype) {
			html = `<!doctype ${value.doctype.name}>${html}`;
		}
		return {
			__userscriptsRequestType: "Document",
			data: html,
			mimeType: value.contentType || "text/html",
		};
	}
	if (typeof File === "function" && value instanceof File) {
		return {
			__userscriptsRequestType: "File",
			data: Array.from(new Uint8Array(await value.arrayBuffer())),
			mimeType: value.type || "",
			name: value.name,
			lastModified: value.lastModified,
		};
	}
	if (value instanceof Blob) {
		return {
			__userscriptsRequestType: "Blob",
			data: Array.from(new Uint8Array(await value.arrayBuffer())),
			mimeType: value.type || "",
		};
	}
	if (value instanceof ArrayBuffer) {
		return {
			__userscriptsRequestType: "ArrayBuffer",
			data: Array.from(new Uint8Array(value)),
		};
	}
	if (ArrayBuffer.isView(value)) {
		return {
			__userscriptsRequestType: "ArrayBufferView",
			data: Array.from(
				new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
			),
			view: value.constructor?.name || "Uint8Array",
		};
	}
	if (value instanceof FormData) {
		const entries = [];
		for (const [key, entryValue] of value.entries()) {
			if (typeof entryValue === "string") {
				entries.push([key, entryValue]);
			} else {
				entries.push([key, await __US_serializeBridgeRequestData(entryValue)]);
			}
		}
		return {
			__userscriptsRequestType: "FormData",
			data: entries,
		};
	}
	if (value instanceof URLSearchParams) {
		return {
			__userscriptsRequestType: "URLSearchParams",
			data: value.toString(),
		};
	}
	return value;
}

function __US_restoreBridgeRequestData(value) {
	if (
		!value ||
		typeof value !== "object" ||
		!value.__userscriptsRequestType
	) {
		return value;
	}
	switch (value.__userscriptsRequestType) {
		case "Text":
			return String(value.data ?? "");
		case "Document": {
			const parser = new DOMParser();
			const mimeType =
				typeof value.mimeType === "string" && value.mimeType.includes("html")
					? "text/html"
					: "text/xml";
			return parser.parseFromString(String(value.data || ""), mimeType);
		}
		case "File": {
			const fileBytes = new Uint8Array(Array.isArray(value.data) ? value.data : []);
			if (typeof File === "function") {
				return new File([fileBytes], value.name || "file", {
					type: value.mimeType || "",
					lastModified: Number(value.lastModified) || Date.now(),
				});
			}
			return new Blob([fileBytes], { type: value.mimeType || "" });
		}
		case "Blob":
			return new Blob(
				[new Uint8Array(Array.isArray(value.data) ? value.data : [])],
				{ type: value.mimeType || "" },
			);
		case "ArrayBuffer":
			return new Uint8Array(Array.isArray(value.data) ? value.data : []).buffer;
		case "ArrayBufferView":
			return __US_restoreTypedArrayView(value.data, value.view);
		case "FormData": {
			const formData = new FormData();
			for (const [key, entryValue] of Array.isArray(value.data) ? value.data : []) {
				formData.append(
					key,
					typeof entryValue === "string"
						? entryValue
						: __US_restoreBridgeRequestData(entryValue),
				);
			}
			return formData;
		}
		case "URLSearchParams":
			return new URLSearchParams(String(value.data || ""));
		default:
			return value;
	}
}

const PAGE_BRIDGE_FILENAME_BOUND_METHODS = new Set([
	"setValue",
	"getValue",
	"deleteValue",
	"listValues",
]);

const PAGE_BRIDGE_CLIENT_METHOD_NAMES = {
	addStyle: "GM_addStyle",
	openInTab: "GM_openInTab",
	closeTab: "GM_closeTab",
	getTab: "GM_getTab",
	saveTab: "GM_saveTab",
	setClipboard: "GM_setClipboard",
	setValue: "GM_setValue",
	getValue: "GM_getValue",
	deleteValue: "GM_deleteValue",
	listValues: "GM_listValues",
};

function normalizePageGrantMethod(method) {
	if (typeof method !== "string" || !method.length) return "";
	if (method === "GM_xmlhttpRequest" || method === "xmlHttpRequest") {
		return "GM_xmlhttpRequest";
	}
	if (method.startsWith("GM.")) return method.slice(3);
	if (method.startsWith("GM_")) return method.slice(3);
	return method;
}

function isPageGrantMethodSupported(method) {
	const normalizedMethod = normalizePageGrantMethod(method);
	return (
		normalizedMethod === "GM_xmlhttpRequest" ||
		Object.prototype.hasOwnProperty.call(USAPI, normalizedMethod)
	);
}

function getAllowedPageGrantMethods(grants) {
	const methods = new Set();
	for (const grant of grants || []) {
		const normalizedMethod = normalizePageGrantMethod(grant);
		if (isPageGrantMethodSupported(normalizedMethod)) {
			methods.add(normalizedMethod);
		}
	}
	return methods;
}

function isPageGrantMethodAllowed(method, allowedMethods) {
	const normalizedMethod = normalizePageGrantMethod(method);
	return allowedMethods instanceof Set && allowedMethods.has(normalizedMethod);
}

const PAGE_BRIDGE_GRANT_TIMEOUT_MS = 30_000;
const PAGE_BRIDGE_MAX_ARGS_LENGTH = 16;
const PAGE_BRIDGE_MAX_ACTIVE_XHR = 8;
const PAGE_BRIDGE_MAX_TRACKED_REQUEST_IDS = 2048;
const PAGE_BRIDGE_REQUEST_ID_MIN_LENGTH = 16;
const PAGE_BRIDGE_REQUEST_ID_MAX_LENGTH = 128;
const PAGE_BRIDGE_MAX_STORAGE_KEY_LENGTH = 512;
const PAGE_BRIDGE_MAX_URL_LENGTH = 8192;
const PAGE_BRIDGE_MAX_STYLE_LENGTH = 1_000_000;
const PAGE_BRIDGE_MAX_OBJECT_KEYS = 128;
const PAGE_BRIDGE_MAX_OBJECT_KEY_LENGTH = 512;
const PAGE_BRIDGE_MAX_ARRAY_LENGTH = 4096;
const PAGE_BRIDGE_MAX_STORAGE_VALUE_BYTES = 2 * 1024 * 1024;
const PAGE_BRIDGE_MAX_SAVE_TAB_BYTES = 1024 * 1024;
const PAGE_BRIDGE_MAX_CLIPBOARD_BYTES = 1024 * 1024;
const PAGE_BRIDGE_MAX_CLIPBOARD_TYPE_LENGTH = 128;
const PAGE_BRIDGE_MAX_CALLS_PER_WINDOW = 200;
const PAGE_BRIDGE_RATE_WINDOW_MS = 10_000;
const PAGE_BRIDGE_MAX_VALUE_DEPTH = 32;
const PAGE_BRIDGE_METHOD_RATE_LIMITS = {
	GM_xmlhttpRequest: { maxCalls: 30, windowMs: 60_000 },
	openInTab: { maxCalls: 5, windowMs: 60_000 },
	saveTab: { maxCalls: 20, windowMs: 60_000 },
	setClipboard: { maxCalls: 10, windowMs: 60_000 },
	setValue: { maxCalls: 200, windowMs: 10_000 },
	getValue: { maxCalls: 200, windowMs: 10_000 },
	deleteValue: { maxCalls: 200, windowMs: 10_000 },
	listValues: { maxCalls: 200, windowMs: 10_000 },
};
const pageBridgeTextEncoder =
	typeof TextEncoder === "function" ? new TextEncoder() : null;

function isPageGrantPlainObject(value) {
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

function copyPageGrantPlainObject(value, maxKeys = PAGE_BRIDGE_MAX_OBJECT_KEYS) {
	if (!isPageGrantPlainObject(value)) {
		throw new Error("Bridge object must be a plain object");
	}
	let descriptors;
	try {
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		throw new Error("Unable to inspect bridge object");
	}
	const copy = {};
	let copiedKeys = 0;
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (!descriptor.enumerable) continue;
		if (
			typeof descriptor.get === "function" ||
			typeof descriptor.set === "function"
		) {
			throw new Error("Bridge accessors are not supported");
		}
		copiedKeys += 1;
		if (copiedKeys > maxKeys) {
			throw new Error("Bridge object has too many keys");
		}
		copy[key] = descriptor.value;
	}
	return copy;
}

function pageBridgeNow() {
	return typeof performance?.now === "function" ? performance.now() : Date.now();
}

function pageBridgeByteLength(value) {
	const text = String(value ?? "");
	if (pageBridgeTextEncoder) {
		return pageBridgeTextEncoder.encode(text).byteLength;
	}
	return text.length * 2;
}

function normalizePageGrantSerializableValue(
	value,
	depth = 0,
	seen = new WeakSet(),
) {
	if (depth > PAGE_BRIDGE_MAX_VALUE_DEPTH) {
		throw new Error("Bridge value exceeds maximum depth");
	}
	if (value === null) return null;
	switch (typeof value) {
		case "string":
		case "boolean":
			return value;
		case "number":
			if (!Number.isFinite(value)) {
				throw new Error("Bridge numeric value must be finite");
			}
			return value;
		case "object":
			break;
		default:
			throw new Error("Bridge value type is not supported");
	}
	if (seen.has(value)) {
		throw new Error("Bridge value must not contain cycles");
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > PAGE_BRIDGE_MAX_ARRAY_LENGTH) {
				throw new Error("Bridge array is too large");
			}
			return value.map((item) =>
				normalizePageGrantSerializableValue(item, depth + 1, seen),
			);
		}
		const copy = copyPageGrantPlainObject(value);
		const result = {};
		for (const [key, entryValue] of Object.entries(copy)) {
			if (key.length > PAGE_BRIDGE_MAX_OBJECT_KEY_LENGTH) {
				throw new Error("Bridge object key is too long");
			}
			result[key] = normalizePageGrantSerializableValue(
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

function normalizePageGrantSerializableObject(value) {
	if (!isPageGrantPlainObject(value)) {
		throw new Error("Bridge value must be a plain object");
	}
	return normalizePageGrantSerializableValue(value);
}

function serializePageGrantValueWithinLimit(value, maxBytes, label) {
	const normalizedValue = normalizePageGrantSerializableValue(value);
	const serializedValue = JSON.stringify(normalizedValue);
	if (typeof serializedValue !== "string") {
		throw new Error(`${label} could not be serialized safely`);
	}
	if (pageBridgeByteLength(serializedValue) > maxBytes) {
		throw new Error(`${label} is too large`);
	}
	return normalizedValue;
}

function consumePageBridgeRateLimit(method, rateLimitState) {
	const now = pageBridgeNow();
	const buckets = [
		{
			key: "__global__",
			maxCalls: PAGE_BRIDGE_MAX_CALLS_PER_WINDOW,
			windowMs: PAGE_BRIDGE_RATE_WINDOW_MS,
		},
	];
	const methodLimit = PAGE_BRIDGE_METHOD_RATE_LIMITS[method];
	if (methodLimit) {
		buckets.push({
			key: method,
			maxCalls: methodLimit.maxCalls,
			windowMs: methodLimit.windowMs,
		});
	}
	for (const bucketDef of buckets) {
		const bucket =
			rateLimitState.get(bucketDef.key) || {
				callCount: 0,
				windowStartedAt: now,
			};
		if (now - bucket.windowStartedAt >= bucketDef.windowMs) {
			bucket.callCount = 0;
			bucket.windowStartedAt = now;
		}
		bucket.callCount += 1;
		rateLimitState.set(bucketDef.key, bucket);
		if (bucket.callCount > bucketDef.maxCalls) {
			throw new Error(`Page grant bridge rate limit exceeded for ${method}`);
		}
	}
}

function consumePageGrantRequestId(id, seenRequestIds) {
	if (
		typeof id !== "string" ||
		id.length < PAGE_BRIDGE_REQUEST_ID_MIN_LENGTH ||
		id.length > PAGE_BRIDGE_REQUEST_ID_MAX_LENGTH ||
		seenRequestIds.has(id)
	) {
		return false;
	}
	seenRequestIds.add(id);
	if (seenRequestIds.size > PAGE_BRIDGE_MAX_TRACKED_REQUEST_IDS) {
		const oldestId = seenRequestIds.values().next().value;
		if (oldestId) seenRequestIds.delete(oldestId);
	}
	return true;
}

function validatePageGrantArgs(method, args) {
	if (!Array.isArray(args) || args.length > PAGE_BRIDGE_MAX_ARGS_LENGTH) {
		return false;
	}
	switch (normalizePageGrantMethod(method)) {
		case "addStyle":
			return (
				args.length === 1 &&
				typeof args[0] === "string" &&
				args[0].length > 0 &&
				args[0].length <= PAGE_BRIDGE_MAX_STYLE_LENGTH
			);
		case "openInTab":
			return (
				args.length >= 1 &&
				args.length <= 2 &&
				typeof args[0] === "string" &&
				args[0].length > 0 &&
				args[0].length <= PAGE_BRIDGE_MAX_URL_LENGTH &&
				(args.length === 1 || typeof args[1] === "boolean")
			);
		case "closeTab":
			return (
				args.length <= 1 &&
				(args.length === 0 ||
					typeof args[0] === "number" ||
					typeof args[0] === "string")
			);
		case "getTab":
		case "listValues":
			return args.length === 0;
		case "saveTab":
			return args.length === 1 && isPageGrantPlainObject(args[0]);
		case "setClipboard":
			return (
				args.length >= 1 &&
				args.length <= 2 &&
				typeof args[0] === "string" &&
				pageBridgeByteLength(args[0]) <= PAGE_BRIDGE_MAX_CLIPBOARD_BYTES &&
				(args.length === 1 ||
					(typeof args[1] === "string" &&
						args[1].length <= PAGE_BRIDGE_MAX_CLIPBOARD_TYPE_LENGTH))
			);
		case "setValue":
			return (
				args.length === 2 &&
				typeof args[0] === "string" &&
				args[0].length > 0 &&
				args[0].length <= PAGE_BRIDGE_MAX_STORAGE_KEY_LENGTH
			);
		case "getValue":
			return (
				args.length >= 1 &&
				args.length <= 2 &&
				typeof args[0] === "string" &&
				args[0].length > 0 &&
				args[0].length <= PAGE_BRIDGE_MAX_STORAGE_KEY_LENGTH
			);
		case "deleteValue":
			return (
				args.length === 1 &&
				typeof args[0] === "string" &&
				args[0].length > 0 &&
				args[0].length <= PAGE_BRIDGE_MAX_STORAGE_KEY_LENGTH
			);
		case "GM_xmlhttpRequest":
			return args.length === 1 && isPageGrantPlainObject(args[0]);
		default:
			return true;
	}
}

async function callPageGrantMethod(method, filename, args = []) {
	const normalizedMethod = normalizePageGrantMethod(method);
	if (normalizedMethod === "GM_xmlhttpRequest") {
		throw new Error("GM_xmlhttpRequest must be handled separately");
	}
	if (!Object.prototype.hasOwnProperty.call(USAPI, normalizedMethod)) {
		throw new Error(`Unsupported bridged grant: ${method}`);
	}
	if (PAGE_BRIDGE_FILENAME_BOUND_METHODS.has(normalizedMethod)) {
		return USAPI[normalizedMethod].bind({ US_filename: filename })(...args);
	}
	return USAPI[normalizedMethod](...args);
}

function getPageGrantClientMethodDefinitions(grants) {
	const methods = getAllowedPageGrantMethods(grants);

	const wrapperLines = [];
	const assignmentLines = [];
	for (const method of methods) {
		if (method === "GM_xmlhttpRequest") continue;
		const legacyName = PAGE_BRIDGE_CLIENT_METHOD_NAMES[method];
		if (!legacyName) continue;
		wrapperLines.push(
			`const ${legacyName} = (...args) => __US_callGrant(${JSON.stringify(legacyName)}, args);\n`,
		);
		assignmentLines.push(`GM.${method} = ${legacyName};\n`);
	}

	return {
		hasXmlHttpRequest: methods.has("GM_xmlhttpRequest"),
		methodWrapperCode: wrapperLines.join(""),
		gmAssignmentCode: assignmentLines.join(""),
	};
}

function getResponseContentType(response) {
	if (!response || typeof response !== "object") return "";
	if (typeof response.contentType === "string" && response.contentType) {
		return response.contentType;
	}
	if (typeof response.responseHeaders !== "string") return "";
	const match = response.responseHeaders.match(
		/(?:^|\r?\n)content-type:\s*([^\r\n]+)/i,
	);
	return match ? match[1].trim() : "";
}

async function serializeXhrResponseValue(value, responseType, contentType) {
	if (value == null) return value;
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (value instanceof ArrayBuffer) {
		return {
			__userscriptsType: "ArrayBuffer",
			data: Array.from(new Uint8Array(value)),
		};
	}
	if (ArrayBuffer.isView(value)) {
		return {
			__userscriptsType: "ArrayBufferView",
			data: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
			view: value.constructor?.name || "Uint8Array",
		};
	}
	if (typeof File === "function" && value instanceof File) {
		return {
			__userscriptsType: "File",
			data: Array.from(new Uint8Array(await value.arrayBuffer())),
			mimeType: value.type || contentType || "",
			name: value.name,
			lastModified: value.lastModified,
		};
	}
	if (value instanceof Blob) {
		return {
			__userscriptsType: "Blob",
			data: Array.from(new Uint8Array(await value.arrayBuffer())),
			mimeType: value.type || contentType || "",
		};
	}
	if (value instanceof Document) {
		let serialized = "";
		try {
			serialized = new XMLSerializer().serializeToString(value);
		} catch {
			serialized = value.documentElement?.outerHTML || "";
		}
		return {
			__userscriptsType: "Document",
			data: serialized,
			mimeType: value.contentType || contentType || "text/html",
		};
	}
	if (responseType === "json") {
		try {
			return JSON.parse(JSON.stringify(value));
		} catch {
			return null;
		}
	}
	return value;
}

async function serializableXhrResponse(response) {
	if (!response || typeof response !== "object") return response;
	const result = {};
	const contentType = getResponseContentType(response);
	for (const key of [
		"readyState",
		"contentType",
		"responseHeaders",
		"responseText",
		"responseType",
		"responseURL",
		"finalUrl",
		"status",
		"statusText",
	]) {
		if (key === "contentType") {
			if (contentType) result.contentType = contentType;
			continue;
		}
		if (key in response) result[key] = response[key];
	}
	if ("response" in response) {
		result.response = await serializeXhrResponseValue(
			response.response,
			response.responseType,
			contentType,
		);
	}
	return result;
}

function installPageGrantBridge(userscript, grants) {
	const filename = userscript.scriptObject.filename;
	const connect = userscript.scriptObject.connect;
	const hasConnectMetadata = Object.prototype.hasOwnProperty.call(
		userscript.scriptObject,
		"connect",
	);
	const pageOrigin = globalThis.location?.origin || "";
	const bridgeId = pageGrantBridgeRandomId();
	const requestEvent = pageGrantBridgeEventName(bridgeId, "request");
	const responseEvent = pageGrantBridgeEventName(bridgeId, "response");
	const abortEvent = pageGrantBridgeEventName(bridgeId, "abort");
	const allowedMethods = getAllowedPageGrantMethods(grants);
	const xhrControls = new Map();
	const seenRequestIds = new Set();
	const rateLimitState = new Map();

	const respond = (id, payload) => {
		safeDispatchEvent(
			document,
			new SafeCustomEvent(responseEvent, {
				detail: { id, ...payload },
			}),
		);
	};

	const handleRequest = async (event) => {
		const detail = event.detail;
		if (!detail || detail.bridgeId !== bridgeId || !detail.id) return;
		const { id, method } = detail;
		let { args = [] } = detail;
		if (!consumePageGrantRequestId(id, seenRequestIds)) return;
		try {
			const normalizedMethod = normalizePageGrantMethod(method);
			if (!isPageGrantMethodAllowed(normalizedMethod, allowedMethods)) {
				throw new Error(`Bridge method not granted: ${method}`);
			}
			consumePageBridgeRateLimit(normalizedMethod, rateLimitState);
			if (!validatePageGrantArgs(method, args)) {
				throw new Error(`Invalid bridge arguments for ${method}`);
			}
			if (normalizedMethod === "setValue") {
				args = [
					args[0],
					serializePageGrantValueWithinLimit(
						args[1],
						PAGE_BRIDGE_MAX_STORAGE_VALUE_BYTES,
						"Storage value",
					),
				];
			} else if (normalizedMethod === "saveTab") {
				args = [
					serializePageGrantValueWithinLimit(
						normalizePageGrantSerializableObject(args[0]),
						PAGE_BRIDGE_MAX_SAVE_TAB_BYTES,
						"Tab state",
					),
				];
			}
			if (normalizedMethod === "GM_xmlhttpRequest") {
				if (xhrControls.size >= PAGE_BRIDGE_MAX_ACTIVE_XHR) {
					throw new Error("Too many active GM_xmlhttpRequest calls");
				}
				const details = copyPageGrantPlainObject(args[0]);
				if (isPageGrantPlainObject(details.headers)) {
					details.headers = copyPageGrantPlainObject(details.headers);
				}
				if ("data" in details) {
					details.data = __US_restoreBridgeRequestData(details.data);
				}
				for (const handler of [
					"onreadystatechange",
					"onloadstart",
					"onprogress",
					"onabort",
					"onerror",
					"onload",
					"ontimeout",
					"onloadend",
				]) {
					details[handler] = async (response) => {
						respond(id, {
							type: "xhr-event",
							handler,
							response: await serializableXhrResponse(response),
						});
						if (
							handler === "onloadend" ||
							handler === "onabort" ||
							handler === "onerror" ||
							handler === "ontimeout"
						) {
							xhrControls.delete(id);
						}
					};
				}
				xhrControls.set(id, null);
				try {
					const control = USAPI.GM_xmlhttpRequest.call(
						{
							US_filename: filename,
							US_connect: connect,
							US_hasConnectMetadata: hasConnectMetadata,
							US_pageOrigin: pageOrigin,
							US_enforceSameOriginWithoutConnect: true,
						},
						details,
					);
					xhrControls.set(id, control);
				} catch (error) {
					xhrControls.delete(id);
					throw error;
				}
				return;
			}
			const result = await callPageGrantMethod(method, filename, args);
			respond(id, { type: "result", result });
		} catch (error) {
			respond(id, {
				type: "error",
				error: String(error?.message || error),
			});
		}
	};

	const handleAbort = (event) => {
		const detail = event.detail;
		if (!detail || detail.bridgeId !== bridgeId || !detail.id) return;
		const control = xhrControls.get(detail.id);
		if (control && typeof control.abort === "function") control.abort();
		xhrControls.delete(detail.id);
	};

	const cleanup = () => {
		safeRemoveEventListener(document, requestEvent, handleRequest);
		safeRemoveEventListener(document, abortEvent, handleAbort);
		for (const control of xhrControls.values()) {
			try {
				control?.abort?.();
			} catch {
				// Ignore cleanup failures.
			}
		}
		xhrControls.clear();
		seenRequestIds.clear();
		rateLimitState.clear();
	};

	safeAddEventListener(document, requestEvent, handleRequest);
	safeAddEventListener(document, abortEvent, handleAbort);
	safeAddEventListener(window, "pagehide", cleanup, { once: true });

	userscript.pageGrantBridge = {
		bridgeId,
		requestEvent,
		responseEvent,
		abortEvent,
		grants: [...grants],
	};
}

function getPageGrantClientPreamble(userscript) {
	void userscript;
	// Privileged GM grants stay out of page world; page access goes through GM.getPageData().
	return "";
}

function getPageGrantClientPostamble(_userscript) {
	return "";
}

function triageJS(userscript) {
	const runAt = userscript.scriptObject["run-at"];
	if (runAt === "document-start") {
		injectJS(userscript);
	} else if (runAt === "document-end") {
		if (document.readyState !== "loading") {
			injectJS(userscript);
		} else {
			document.addEventListener(
				"DOMContentLoaded",
				() => injectJS(userscript),
				{ once: true },
			);
		}
	} else if (runAt === "document-idle") {
		if (document.readyState === "complete") {
			injectJS(userscript);
		} else {
			const handle = () => {
				if (document.readyState === "complete") {
					injectJS(userscript);
					document.removeEventListener("readystatechange", handle);
				}
			};
			document.addEventListener("readystatechange", handle);
		}
	}
}

function injectJS(userscript) {
	const filename = userscript.scriptObject.filename;
	const name = userscript.scriptObject.name;
	const pageGrantPreamble = getPageGrantClientPreamble(userscript);
	const pageGrantPostamble = getPageGrantClientPostamble(userscript);
	const code = `\
(async () => {
	try {
${pageGrantPreamble}
// ===UserScript===start===
${userscript.code}
// ===UserScript====end====
${pageGrantPostamble}
	} catch (error) {
		console.error(\`${filename.replaceAll("`", "\\`")}\`, error);
	}
})(); //# sourceURL=${filename.replace(/[\s"']/g, "-") + usTag}`;
	let injectInto = userscript.scriptObject["inject-into"];
	if (userscript.forceContentInjection) {
		injectInto = "content";
	}
	// change scope to content since strict CSP event detected
	if (injectInto === "auto" && (userscript.fallback || cspFallbackAttempted)) {
		injectInto = "content";
		console.warn(`Attempting fallback injection for ${name}`);
	}
	const world = injectInto === "content" ? "content" : "page";
	if (window.self === window.top) {
		console.info(`Injecting: ${name} %c(js/${world})`, colors.yellow);
	} else {
		console.info(
			`Injecting: ${name} %c(js/${world})%c - %cframe(${label})(${window.location})`,
			colors.yellow,
			colors.inherit,
			colors.blue,
		);
	}
	if (world === "page") {
		const div = document.createElement("div");
		div.style.display = "none";
		const shadowRoot = div.attachShadow({ mode: "closed" });
		const tag = document.createElement("script");
		tag.textContent = code;
		shadowRoot.append(tag);
		(document.body ?? document.head ?? document.documentElement).append(div);
	} else {
		try {
			// eslint-disable-next-line no-new-func
			return Function(
				`{${Object.keys(userscript.apis).join(",")}}`,
				code,
			)(userscript.apis);
		} catch (error) {
			console.error(`"${filename}" error:`, error);
		}
	}
}

function injectCSS(name, code) {
	if (window.self === window.top) {
		console.info(`Injecting ${name} %c(css)`, "color: #60f36c");
	} else {
		console.info(
			`Injecting ${name} %c(css)%c - %cframe(${label})(${window.location})`,
			"color: #60f36c",
			colors.inherit,
			colors.blue,
		);
	}
	// Safari lacks full support for tabs.insertCSS
	// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/insertCSS
	// specifically frameId and cssOrigin
	// if support for those details keys arrives, the method below can be used
	// NOTE: manifest V3 does support frameId, but not origin
	// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/insertCSS

	// write the css code to head of the document
	const tag = document.createElement("style");
	tag.textContent = code;
	document.head.appendChild(tag);
}

function cspFallback(e) {
	// if a security policy violation event has occurred
	// and the directive is script-src or script-src-elem
	// it's fair to assume that there is a strict CSP for javascript
	// and that injection was blocked for all userscripts
	// when any script-src violation is detected, re-attempt injection
	if (
		e.effectiveDirective === "script-src" ||
		e.effectiveDirective === "script-src-elem"
	) {
		// get all "auto" code
		// since other code can trigger a security policy violation event
		// make sure data var is not undefined before attempting fallback
		if (!data || cspFallbackAttempted) return;
		// update global that tracks security policy violations
		cspFallbackAttempted = true;
		// for all userscripts with @inject-into: auto, attempt re-injection
		for (let i = 0; i < data.files.js.length; i++) {
			const userscript = data.files.js[i];
			if (userscript.scriptObject["inject-into"] !== "auto") continue;
			userscript.fallback = 1;
			triageJS(userscript);
		}
	}
}

async function injection() {
	const response = await browser.runtime.sendMessage({
		name: "REQ_USERSCRIPTS",
	});
	// cancel injection if errors detected
	if (!response || response.error) {
		console.error(response?.error || "REQ_USERSCRIPTS returned undefined");
		return;
	}
	// save response locally in case CSP events occur
	data = response;
	// combine regular and context-menu scripts
	const scripts = [...data.files.js, ...data.files.menu];
	// loop through each userscript and prepare for processing
	for (let i = 0; i < scripts.length; i++) {
		const userscript = scripts[i];
		const filename = userscript.scriptObject.filename;
		const grants = userscript.scriptObject.grant;
		const connect = userscript.scriptObject.connect;
		const hasConnectMetadata = Object.prototype.hasOwnProperty.call(
			userscript.scriptObject,
			"connect",
		);
		const injectInto = userscript.scriptObject["inject-into"];
		const xhrContext = {
			US_filename: filename,
			US_connect: connect,
			US_hasConnectMetadata: hasConnectMetadata,
			US_pageOrigin: globalThis.location?.origin || "",
			US_enforceSameOriginWithoutConnect: true,
		};
		// create GM.info object, all userscripts get access to GM.info
		userscript.apis = { GM: {} };
		userscript.apis.GM.info = {
			script: userscript.scriptObject,
			scriptHandler: data.scriptHandler,
			scriptHandlerVersion: data.scriptHandlerVersion,
			scriptMetaStr: userscript.scriptMetaStr,
			version: data.scriptHandlerVersion,
		};
		// add GM_info
		userscript.apis.GM_info = userscript.apis.GM.info;
		// if @grant explicitly set to none, empty grants array
		if (grants.includes("none")) grants.length = 0;
		if (grants.length && (injectInto === "page" || injectInto === "auto")) {
			userscript.forceContentInjection = true;
			console.warn(
				`${filename} requested @inject-into ${injectInto} with @grant values; forcing content injection. Use GM.getPageData() for page-context data access.`,
			);
		}
		// loop through each userscript @grant value, add methods as needed
		for (let j = 0; j < grants.length; j++) {
			const grant = grants[j];
			const method = grant.startsWith("GM.") ? grant.slice(3) : grant;
			// ensure API method exists in USAPI object
			if (!Object.keys(USAPI).includes(method)) continue;
			// add granted methods
			switch (method) {
				case "info":
				case "GM_info":
					continue;
				case "getValue":
				case "setValue":
				case "deleteValue":
				case "listValues":
					userscript.apis.GM[method] = USAPI[method].bind({
						US_filename: filename,
					});
					break;
				case "xmlHttpRequest":
				case "GM_xmlhttpRequest":
					if (method === "xmlHttpRequest") {
						userscript.apis.GM[method] = USAPI[method].bind(xhrContext);
					} else {
						userscript.apis[method] = USAPI[method].bind(xhrContext);
					}
					break;
				default:
					userscript.apis.GM[method] = USAPI[method];
			}
		}
		// triage userjs item for injection
		triageJS(userscript);
	}
	// loop through each usercss and inject
	for (let i = 0; i < data.files.css.length; i++) {
		const userstyle = data.files.css[i];
		injectCSS(userstyle.name, userstyle.code);
	}
}

function listeners() {
	/** listen for CSP violations */
	document.addEventListener("securitypolicyviolation", cspFallback, {
		once: true,
	});
	/**
	 * listens for messages from background, popup, etc...
	 * @type {import("webextension-polyfill").Runtime.OnMessageListener}
	 */
	const handleMessage = (message) => {
		const name = message.name;
		if (name === "CONTEXT_RUN") {
			// from bg script when context-menu item is clicked
			// double check to ensure context-menu scripts only run in top windows
			if (window !== window.top) return;
			// loop through context-menu scripts saved to data object and find match
			// if no match found, nothing will execute and error will log
			const filename = message.menuItemId;
			for (let i = 0; i < data.files.menu.length; i++) {
				const item = data.files.menu[i];
				if (item.scriptObject.filename === filename) {
					console.info(`Injecting ${filename} %c(js)`, colors.yellow);
					injectJS(item);
					return;
				}
			}
			console.error(`Couldn't find ${filename} code!`);
		}
	};
	/** Dynamically remove listeners to avoid memory leaks */
	if (document.visibilityState === "visible") {
		browser.runtime.onMessage.addListener(handleMessage);
	}
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) {
			browser.runtime.onMessage.removeListener(handleMessage);
		} else {
			browser.runtime.onMessage.addListener(handleMessage);
		}
	});
}

async function initialize() {
	const results = await browser.storage.local.get("US_GLOBAL_ACTIVE");
	if (results?.US_GLOBAL_ACTIVE === false)
		return console.info("Userscripts off");
	// start the injection process and add the listeners
	injection();
	listeners();
}

initialize();
