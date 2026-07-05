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

function randomLabel() {
	const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	const r = Math.random();
	return a[Math.floor(r * a.length)] + r.toString().slice(5, 6);
}



function pageGrantBridgeEventName(id, type) {
	return `__userscripts_page_grant_bridge_${id}_${type}__`;
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
	const methods = new Set();
	for (const grant of grants || []) {
		const normalizedMethod = normalizePageGrantMethod(grant);
		if (isPageGrantMethodSupported(normalizedMethod)) {
			methods.add(normalizedMethod);
		}
	}

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
	const bridgeId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
	const requestEvent = pageGrantBridgeEventName(bridgeId, "request");
	const responseEvent = pageGrantBridgeEventName(bridgeId, "response");
	const abortEvent = pageGrantBridgeEventName(bridgeId, "abort");
	const xhrControls = new Map();

	const respond = (id, payload) => {
		document.dispatchEvent(
			new CustomEvent(responseEvent, {
				detail: { id, ...payload },
			}),
		);
	};

	const handleRequest = async (event) => {
		const detail = event.detail;
		if (!detail || detail.bridgeId !== bridgeId || !detail.id) return;
		const { id, method, args = [] } = detail;
		try {
			if (normalizePageGrantMethod(method) === "GM_xmlhttpRequest") {
				const details = { ...(args[0] || {}) };
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
				const control = USAPI.GM_xmlhttpRequest(details);
				xhrControls.set(id, control);
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

	document.addEventListener(requestEvent, handleRequest);
	document.addEventListener(abortEvent, handleAbort);

	userscript.pageGrantBridge = {
		bridgeId,
		requestEvent,
		responseEvent,
		abortEvent,
		grants: [...grants],
	};
}

function getPageGrantClientPreamble(userscript) {
	const bridge = userscript.pageGrantBridge;
	if (!bridge) return "";
	const info = userscript.apis?.GM?.info || userscript.apis?.GM_info || {};
	const { hasXmlHttpRequest, methodWrapperCode, gmAssignmentCode } =
		getPageGrantClientMethodDefinitions(bridge.grants);
	return (
		`const __US_BRIDGE_ID__ = ${JSON.stringify(bridge.bridgeId)};\n` +
		`const __US_REQUEST_EVENT__ = ${JSON.stringify(bridge.requestEvent)};\n` +
		`const __US_RESPONSE_EVENT__ = ${JSON.stringify(bridge.responseEvent)};\n` +
		`const __US_ABORT_EVENT__ = ${JSON.stringify(bridge.abortEvent)};\n` +
		`const GM_info = ${JSON.stringify(info)};\n` +
		`const GM = { info: GM_info };\n` +
		`const __US_randomId = () => Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);\n` +
		`const __US_terminalXhrHandlers = new Set(['onloadend','onabort','onerror','ontimeout']);\n` +
		`const __US_parseHeaders = (raw) => {\n` +
		`  const headers = {};\n` +
		`  if (typeof raw !== 'string' || !raw) return headers;\n` +
		`  for (const line of raw.split(/\\r?\\n/)) {\n` +
		`    const match = /^([\\w-]+):\\s*(.+)$/.exec(line);\n` +
		`    if (match) headers[match[1].toLowerCase()] = match[2];\n` +
		`  }\n` +
		`  return headers;\n` +
		`};\n` +
		`const __US_restoreXhrValue = (value, responseType, responseHeaders, contentType) => {\n` +
		`  if (!value || typeof value !== 'object' || !value.__userscriptsType) return value;\n` +
		`  const mimeType = contentType || (__US_parseHeaders(responseHeaders)['content-type'] || '');\n` +
		`  if (value.__userscriptsType === 'ArrayBuffer') return new Uint8Array(value.data || []).buffer;\n` +
		`  if (value.__userscriptsType === 'ArrayBufferView') return new Uint8Array(value.data || []);\n` +
		`  if (value.__userscriptsType === 'Blob') return new Blob([new Uint8Array(value.data || [])], { type: value.mimeType || mimeType || '' });\n` +
		`  if (value.__userscriptsType === 'Document') {\n` +
		`    const parser = new DOMParser();\n` +
		`    const type = (value.mimeType || mimeType || '').includes('html') ? 'text/html' : 'text/xml';\n` +
		`    return parser.parseFromString(String(value.data || ''), type);\n` +
		`  }\n` +
		`  return value;\n` +
		`};\n` +
		`const __US_restoreXhrResponse = (response) => {\n` +
		`  if (!response || typeof response !== 'object') return response;\n` +
		`  const restored = { ...response };\n` +
		`  restored.getAllResponseHeaders = () => String(restored.responseHeaders || '');\n` +
		`  restored.getResponseHeader = (name) => __US_parseHeaders(restored.responseHeaders || '')[String(name || '').toLowerCase()] || null;\n` +
		`  restored.response = __US_restoreXhrValue(restored.response, restored.responseType, restored.responseHeaders, restored.contentType);\n` +
		`  if ((restored.responseType === '' || restored.responseType === 'text') && typeof restored.response === 'string') {\n` +
		`    restored.responseText = restored.response;\n` +
		`  }\n` +
		`  if (restored.responseType === 'document' && restored.response instanceof Document) {\n` +
		`    restored.responseXML = restored.response;\n` +
		`  }\n` +
		`  return restored;\n` +
		`};\n` +
		`const __US_callGrant = (method, args = []) => new Promise((resolve, reject) => {\n` +
		`  const id = __US_randomId();\n` +
		`  const onResponse = (event) => {\n` +
		`    const detail = event.detail || {};\n` +
		`    if (detail.id !== id) return;\n` +
		`    if (detail.type === 'result') { document.removeEventListener(__US_RESPONSE_EVENT__, onResponse); resolve(detail.result); return; }\n` +
		`    if (detail.type === 'error') { document.removeEventListener(__US_RESPONSE_EVENT__, onResponse); reject(new Error(detail.error || 'Userscripts grant bridge error')); }\n` +
		`  };\n` +
		`  document.addEventListener(__US_RESPONSE_EVENT__, onResponse);\n` +
		`  document.dispatchEvent(new CustomEvent(__US_REQUEST_EVENT__, { detail: { bridgeId: __US_BRIDGE_ID__, id, method, args } }));\n` +
		`});\n` +
		(hasXmlHttpRequest
			? `function GM_xmlhttpRequest(details) {\n` +
				`  const id = __US_randomId();\n` +
				`  const callbacks = {};\n` +
				`  const payload = { ...(details || {}) };\n` +
				`  for (const key of ['onreadystatechange','onloadstart','onprogress','onabort','onerror','onload','ontimeout','onloadend']) {\n` +
				`    if (typeof payload[key] === 'function') { callbacks[key] = payload[key]; delete payload[key]; }\n` +
				`  }\n` +
				`  const onResponse = (event) => {\n` +
				`    const detail = event.detail || {};\n` +
				`    if (detail.id !== id) return;\n` +
				`    if (detail.type === 'xhr-event') {\n` +
				`      const cb = callbacks[detail.handler];\n` +
				`      if (typeof cb === 'function') cb(__US_restoreXhrResponse(detail.response));\n` +
				`      if (__US_terminalXhrHandlers.has(detail.handler)) document.removeEventListener(__US_RESPONSE_EVENT__, onResponse);\n` +
				`      return;\n` +
				`    }\n` +
				`    if (detail.type === 'error') {\n` +
				`      document.removeEventListener(__US_RESPONSE_EVENT__, onResponse);\n` +
				`      if (typeof callbacks.onerror === 'function') callbacks.onerror({ error: detail.error });\n` +
				`    }\n` +
				`  };\n` +
				`  document.addEventListener(__US_RESPONSE_EVENT__, onResponse);\n` +
				`  document.dispatchEvent(new CustomEvent(__US_REQUEST_EVENT__, { detail: { bridgeId: __US_BRIDGE_ID__, id, method: 'GM_xmlhttpRequest', args: [payload] } }));\n` +
				`  return { abort() { document.removeEventListener(__US_RESPONSE_EVENT__, onResponse); document.dispatchEvent(new CustomEvent(__US_ABORT_EVENT__, { detail: { bridgeId: __US_BRIDGE_ID__, id } })); } };\n` +
				`}\n` +
				`GM.xmlHttpRequest = (details) => new Promise((resolve, reject) => {\n` +
				`  GM_xmlhttpRequest({ ...(details || {}), onloadend: resolve, onerror: reject, ontimeout: reject, onabort: reject });\n` +
				`});\n` +
				`GM.xmlhttpRequest = GM.xmlHttpRequest;\n`
			: "") +
		methodWrapperCode +
		gmAssignmentCode
	);
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
		const injectInto = userscript.scriptObject["inject-into"];
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
		// @grant values exist for page/auto scoped userscripts.
		// Keep the userscript in the page world and expose granted APIs through a
		// content-world bridge instead of stripping grants or forcing content mode.
		// This preserves access to page globals while privileged APIs still
		// execute in the content script. When strict CSP blocks page injection,
		// the existing fallback path will still retry in content.
		if (grants.length && (injectInto === "page" || injectInto === "auto")) {
			installPageGrantBridge(userscript, grants);
			console.info(
				`${filename} @grant values bridged for @inject-into value: ${injectInto}`,
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
				case "GM_xmlhttpRequest":
					userscript.apis[method] = USAPI[method];
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
