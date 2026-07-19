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
	"connection",
	"content-length",
	"cookie",
	"cookie2",
	"host",
	"origin",
	"referer",
	"proxy-authorization",
	"proxy-connection",
]);
const XHR_FORBIDDEN_HEADER_PREFIXES = ["proxy-", "sec-"];
const XHR_MAX_TIMEOUT_MS = 120_000;
const XHR_MAX_HEADER_VALUE_LENGTH = 8192;
const XHR_MAX_HEADER_COUNT = 64;

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
