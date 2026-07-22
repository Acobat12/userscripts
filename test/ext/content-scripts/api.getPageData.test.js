import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

const apiModuleUrl = new URL(
	"../../../src/ext/content-scripts/api.js",
	import.meta.url,
).href;

class FakeEvent {
	constructor(type, init = {}) {
		this.type = String(type);
		this.target = null;
		this.currentTarget = null;
		this.bubbles = Boolean(init.bubbles);
		this.cancelable = Boolean(init.cancelable);
		this.composed = Boolean(init.composed);
		this.defaultPrevented = false;
	}

	preventDefault() {
		if (this.cancelable) {
			this.defaultPrevented = true;
		}
	}
}

class FakeCustomEvent extends FakeEvent {
	constructor(type, init = {}) {
		super(type, init);
		this.detail = init.detail;
	}
}

class FakeMouseEvent extends FakeEvent {
	constructor(type, init = {}) {
		super(type, init);
		this.button = init.button ?? 0;
		this.buttons = init.buttons ?? 0;
		this.clientX = init.clientX ?? 0;
		this.clientY = init.clientY ?? 0;
		this.screenX = init.screenX ?? 0;
		this.screenY = init.screenY ?? 0;
		this.ctrlKey = Boolean(init.ctrlKey);
		this.shiftKey = Boolean(init.shiftKey);
		this.altKey = Boolean(init.altKey);
		this.metaKey = Boolean(init.metaKey);
	}
}

class FakeKeyboardEvent extends FakeEvent {
	constructor(type, init = {}) {
		super(type, init);
		this.key = init.key ?? "";
		this.code = init.code ?? "";
		this.location = init.location ?? 0;
		this.repeat = Boolean(init.repeat);
		this.ctrlKey = Boolean(init.ctrlKey);
		this.shiftKey = Boolean(init.shiftKey);
		this.altKey = Boolean(init.altKey);
		this.metaKey = Boolean(init.metaKey);
	}
}

class FakeInputEvent extends FakeEvent {
	constructor(type, init = {}) {
		super(type, init);
		this.data = init.data ?? null;
		this.inputType = init.inputType ?? "";
		this.isComposing = Boolean(init.isComposing);
	}
}

class FakeEventTarget {
	constructor() {
		this._listeners = new Map();
	}

	addEventListener(type, listener, options = {}) {
		if (typeof listener !== "function") return;
		const normalizedType = String(type);
		const listeners = this._listeners.get(normalizedType) || [];
		listeners.push({
			listener,
			once: options === true || options?.once === true,
		});
		this._listeners.set(normalizedType, listeners);
	}

	removeEventListener(type, listener) {
		const normalizedType = String(type);
		const listeners = this._listeners.get(normalizedType);
		if (!listeners?.length) return;
		const nextListeners = listeners.filter((entry) => entry.listener !== listener);
		if (nextListeners.length) {
			this._listeners.set(normalizedType, nextListeners);
		} else {
			this._listeners.delete(normalizedType);
		}
	}

	dispatchEvent(event) {
		if (!event || typeof event.type === "undefined") {
			throw new TypeError("Invalid event");
		}
		event.target = this;
		const listeners = [...(this._listeners.get(String(event.type)) || [])];
		for (const entry of listeners) {
			if (entry.once) {
				this.removeEventListener(event.type, entry.listener);
			}
			event.currentTarget = this;
			entry.listener.call(this, event);
		}
		event.currentTarget = null;
		return !event.defaultPrevented;
	}
}

class FakeNode extends FakeEventTarget {
	constructor(ownerDocument = null) {
		super();
		this.ownerDocument = ownerDocument;
		this.parentNode = null;
		this.childNodes = [];
	}

	get isConnected() {
		let current = this;
		while (current) {
			if (current instanceof FakeDocument) return true;
			current = current.parentNode;
		}
		return false;
	}

	appendChild(child) {
		if (!(child instanceof FakeNode)) {
			throw new TypeError("Expected a FakeNode");
		}
		if (child.parentNode) {
			child.parentNode.removeChild(child);
		}
		child.parentNode = this;
		child.ownerDocument = this.ownerDocument || child.ownerDocument;
		this.childNodes.push(child);
		if (this.isConnected) {
			child._connectTree();
		}
		return child;
	}

	removeChild(child) {
		const index = this.childNodes.indexOf(child);
		if (index === -1) {
			throw new Error("Child not found");
		}
		this.childNodes.splice(index, 1);
		child.parentNode = null;
		return child;
	}

	_connectTree() {
		if (this.shadowRoot) {
			this.shadowRoot._connectTree();
		}
		if (this.tagName === "SCRIPT" && !this._executed) {
			this._executed = true;
			vm.runInThisContext(String(this.textContent || ""));
		}
		for (const child of this.childNodes) {
			child._connectTree();
		}
	}
}

class FakeElement extends FakeNode {
	constructor(ownerDocument, tagName) {
		super(ownerDocument);
		this.tagName = String(tagName).toUpperCase();
		this.style = {};
		this.textContent = "";
		this.shadowRoot = null;
		this.id = "";
		this.className = "";
		this.value = "";
		this.checked = false;
		this.disabled = false;
		this.selectedIndex = -1;
		this.href = "";
		this.src = "";
		this.title = "";
		this.name = "";
		this.type = "";
		this.placeholder = "";
		this.lang = "";
		this.dir = "";
		this.ariaLabel = "";
		this.tabIndex = -1;
		this._rect = {
			x: 0,
			y: 0,
			width: 0,
			height: 0,
			top: 0,
			right: 0,
			bottom: 0,
			left: 0,
		};
		this._attributes = Object.create(null);
	}

	get innerText() {
		return this.textContent;
	}

	set innerText(value) {
		this.textContent = String(value);
	}

	get classList() {
		return this.className.split(/\s+/).filter(Boolean);
	}

	get innerHTML() {
		if (this.childNodes.length) {
			return this.childNodes.map((child) => serializeFakeNode(child)).join("");
		}
		return this.textContent;
	}

	get outerHTML() {
		return `<${this.tagName.toLowerCase()}${serializeFakeAttributes(this)}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
	}

	attachShadow() {
		const shadowRoot = new FakeShadowRoot(this.ownerDocument, this);
		this.shadowRoot = shadowRoot;
		return shadowRoot;
	}

	remove() {
		if (this.parentNode) {
			this.parentNode.removeChild(this);
		}
	}

	click() {
		return this.dispatchEvent(
			new FakeMouseEvent("click", {
				bubbles: true,
				cancelable: true,
				composed: true,
			}),
		);
	}

	focus() {
		this.ownerDocument.activeElement = this;
	}

	blur() {
		if (this.ownerDocument.activeElement === this) {
			this.ownerDocument.activeElement = null;
		}
	}

	setAttribute(name, value) {
		const normalizedName = String(name);
		const normalizedValue = String(value);
		this._attributes[normalizedName] = normalizedValue;
		if (normalizedName === "id") this.id = normalizedValue;
		if (normalizedName === "class") this.className = normalizedValue;
	}

	getAttribute(name) {
		const normalizedName = String(name);
		return Object.prototype.hasOwnProperty.call(this._attributes, normalizedName)
			? this._attributes[normalizedName]
			: null;
	}

	getBoundingClientRect() {
		return { ...this._rect };
	}

	querySelector(selector) {
		return querySelectorFrom(this, selector);
	}

	querySelectorAll(selector) {
		return querySelectorAllFrom(this, selector);
	}
}

class FakeShadowRoot extends FakeNode {
	constructor(ownerDocument, host) {
		super(ownerDocument);
		this.host = host;
		this.parentNode = host;
	}
}

class FakeDocument extends FakeNode {
	constructor() {
		super(null);
		this.ownerDocument = this;
		this.readyState = "complete";
		this.hidden = false;
		this.visibilityState = "visible";
		this.title = "Example Title";
		this.activeElement = null;
		this._selectionText = "";
		this.documentElement = new FakeElement(this, "html");
		this.head = new FakeElement(this, "head");
		this.body = new FakeElement(this, "body");
		super.appendChild(this.documentElement);
		this.documentElement.appendChild(this.head);
		this.documentElement.appendChild(this.body);
	}

	createElement(tagName) {
		return new FakeElement(this, tagName);
	}

	querySelector(selector) {
		return querySelectorFrom(this, selector);
	}

	querySelectorAll(selector) {
		return querySelectorAllFrom(this, selector);
	}
}

class FakeWindow {
	constructor(document) {
		this.document = document;
		this.top = this;
		this.window = this;
	}
}

function installFakeDom(extraGlobals = {}) {
	const previousGlobals = new Map();
	const document = new FakeDocument();
	const window = new FakeWindow(document);
	const locationUrl = new URL("https://example.test/page?tab=1#section");
	const location = {
		href: locationUrl.href,
		origin: locationUrl.origin,
		protocol: locationUrl.protocol,
		host: locationUrl.host,
		hostname: locationUrl.hostname,
		pathname: locationUrl.pathname,
		search: locationUrl.search,
		hash: locationUrl.hash,
	};
	window.location = location;
	const globalAssignments = {
		Event: FakeEvent,
		CustomEvent: FakeCustomEvent,
		MouseEvent: FakeMouseEvent,
		KeyboardEvent: FakeKeyboardEvent,
		InputEvent: FakeInputEvent,
		EventTarget: FakeEventTarget,
		Node: FakeNode,
		Element: FakeElement,
		Document: FakeDocument,
		document,
		window,
		location,
		getSelection() {
			return {
				toString() {
					return String(document._selectionText ?? "");
				},
			};
		},
		app: undefined,
		browser: createDefaultBrowserMock(),
		...extraGlobals,
	};
	for (const [key, value] of Object.entries(globalAssignments)) {
		previousGlobals.set(
			key,
			Object.prototype.hasOwnProperty.call(globalThis, key)
				? globalThis[key]
				: undefined,
		);
		globalThis[key] = value;
	}
	return {
		document,
		window,
		restore() {
			for (const [key, value] of previousGlobals) {
				if (typeof value === "undefined") {
					delete globalThis[key];
				} else {
					globalThis[key] = value;
				}
			}
		},
	};
}

function matchesSelector(element, selector) {
	const normalizedSelector = String(selector).trim();
	if (!normalizedSelector) return false;
	if (normalizedSelector.startsWith("#")) {
		return element.id === normalizedSelector.slice(1);
	}
	if (normalizedSelector.startsWith(".")) {
		return element.className
			.split(/\s+/)
			.filter(Boolean)
			.includes(normalizedSelector.slice(1));
	}
	return element.tagName === normalizedSelector.toUpperCase();
}

function querySelectorFrom(root, selector) {
	const stack = [...root.childNodes];
	while (stack.length) {
		const node = stack.shift();
		if (node instanceof FakeElement && matchesSelector(node, selector)) {
			return node;
		}
		if (node?.childNodes?.length) {
			stack.unshift(...node.childNodes);
		}
	}
	return null;
}

function querySelectorAllFrom(root, selector) {
	const result = [];
	const stack = [...root.childNodes];
	while (stack.length) {
		const node = stack.shift();
		if (node instanceof FakeElement && matchesSelector(node, selector)) {
			result.push(node);
		}
		if (node?.childNodes?.length) {
			stack.unshift(...node.childNodes);
		}
	}
	return result;
}

function serializeFakeAttributes(element) {
	const entries = Object.entries(element._attributes);
	if (!entries.length) {
		return "";
	}
	return entries
		.map(([key, value]) => ` ${key}="${String(value)}"`)
		.join("");
}

function serializeFakeNode(node) {
	if (node instanceof FakeElement) {
		return node.outerHTML;
	}
	return String(node?.textContent ?? "");
}

function appendElement(parent, tagName, options = {}) {
	const element = parent.ownerDocument.createElement(tagName);
	if (options.id) element.setAttribute("id", options.id);
	if (options.className) element.setAttribute("class", options.className);
	if (options.attributes && typeof options.attributes === "object") {
		for (const [name, value] of Object.entries(options.attributes)) {
			element.setAttribute(name, value);
		}
	}
	if (typeof options.textContent === "string") {
		element.textContent = options.textContent;
	}
	if (options.properties && typeof options.properties === "object") {
		Object.assign(element, options.properties);
	}
	if (options.rect && typeof options.rect === "object") {
		element._rect = {
			...element._rect,
			...options.rect,
		};
	}
	parent.appendChild(element);
	return element;
}

function buildFakePageEvent(spec) {
	const init = {
		bubbles: Boolean(spec?.bubbles),
		cancelable: Boolean(spec?.cancelable),
		composed: Boolean(spec?.composed),
	};
	switch (spec?.kind) {
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
			return new InputEvent(spec.type, init);
		default:
			return new Event(spec.type, init);
	}
}

function buildFakeLocationSnapshot(fields = [
	"href",
	"origin",
	"protocol",
	"host",
	"hostname",
	"pathname",
	"search",
	"hash",
]) {
	const result = Object.create(null);
	for (const field of fields) {
		result[field] = String(globalThis.location?.[field] ?? "");
	}
	return result;
}

function buildFakeVisibilitySnapshot() {
	return {
		hidden: Boolean(document.hidden),
		visibilityState: String(document.visibilityState ?? ""),
	};
}

function buildFakeRectSnapshot(target) {
	if (!target || typeof target.getBoundingClientRect !== "function") {
		return null;
	}
	const rect = target.getBoundingClientRect();
	return {
		x: Number(rect.x ?? 0),
		y: Number(rect.y ?? 0),
		width: Number(rect.width ?? 0),
		height: Number(rect.height ?? 0),
		top: Number(rect.top ?? 0),
		right: Number(rect.right ?? 0),
		bottom: Number(rect.bottom ?? 0),
		left: Number(rect.left ?? 0),
	};
}

function buildFakeClassListSnapshot(target) {
	if (!target) {
		return null;
	}
	if (Array.isArray(target.classList)) {
		return [...target.classList];
	}
	if (typeof target.className === "string") {
		return target.className.split(/\s+/).filter(Boolean);
	}
	return [];
}

function buildFakeSelectionText() {
	return String(globalThis.getSelection?.()?.toString?.() ?? "");
}

function normalizeFakePageDataResult(value, depth = 0, seen = new WeakSet()) {
	if (depth > 32) {
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
			if (value.length > 4096) {
				throw new Error("Page data result array is too large");
			}
			const result = new Array(value.length);
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (!descriptor) continue;
				if (
					typeof descriptor.get === "function" ||
					typeof descriptor.set === "function" ||
					!Object.prototype.hasOwnProperty.call(descriptor, "value")
				) {
					throw new Error("Page data result contains an accessor descriptor");
				}
				result[index] = normalizeFakePageDataResult(
					descriptor.value,
					depth + 1,
					seen,
				);
			}
			return result;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error("Page data result object must be plain");
		}
		const keys = Object.keys(value);
		if (keys.length > 128) {
			throw new Error("Page data result object has too many keys");
		}
		const result = Object.create(null);
		for (const key of keys) {
			if (key.length > 512) {
				throw new Error("Page data result object key is too long");
			}
			if (key === "__proto__" || key === "prototype" || key === "constructor") {
				throw new Error("Page data result object key is not allowed");
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (
				typeof descriptor?.get === "function" ||
				typeof descriptor?.set === "function" ||
				!Object.prototype.hasOwnProperty.call(descriptor || {}, "value")
			) {
				throw new Error("Page data result contains an accessor descriptor");
			}
			result[key] = normalizeFakePageDataResult(
				descriptor.value,
				depth + 1,
				seen,
			);
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

async function executeFakePageTask(message) {
	if (message?.name !== "API_PAGE_EXECUTE") {
		throw new Error(`Unsupported message: ${message?.name}`);
	}
	const task = message.task;
	if (!task || typeof task !== "object" || Array.isArray(task)) {
		throw new Error("Invalid page task");
	}
	if (task.kind === "getPageData") {
		const extractor = vm.runInThisContext(`(${task.extractorSource})`);
		const args = JSON.parse(task.argsJson);
		try {
			const value = normalizeFakePageDataResult(await extractor(...args));
			return {
				status: "fulfilled",
				result: {
					transport: "scripting.executeScript",
					ok: true,
					value,
				},
			};
		} catch (error) {
			return {
				status: "fulfilled",
				result: {
					transport: "scripting.executeScript",
					ok: false,
					error: String(error?.message || error),
				},
			};
		}
	}
	if (task.kind === "pageCall") {
		const args = JSON.parse(task.argsJson);
		const [selector, spec] = args;
		const target =
			typeof selector === "string" ? document.querySelector(selector) : null;
		const targets =
			typeof selector === "string" ? document.querySelectorAll(selector) : [];
		try {
			let value;
			switch (task.operation) {
				case "dom.exists":
					value = Boolean(target);
					break;
				case "dom.count":
					value = targets.length;
					break;
				case "dom.queryText":
					value = target ? String(target.textContent ?? "") : null;
					break;
				case "dom.queryHtml":
					value = target ? String(target.innerHTML ?? "") : null;
					break;
				case "dom.queryOuterHtml":
					value = target ? String(target.outerHTML ?? "") : null;
					break;
				case "dom.queryAttr":
					value =
						target && typeof target.getAttribute === "function"
							? target.getAttribute(args[1])
							: null;
					break;
				case "dom.queryProperty":
					value = target ? target[args[1]] ?? null : null;
					break;
				case "dom.queryRect":
					value = buildFakeRectSnapshot(target);
					break;
				case "dom.queryClassList":
					value = buildFakeClassListSnapshot(target);
					break;
				case "dom.queryAllText":
					value = targets.map((item) => String(item.textContent ?? ""));
					break;
				case "dom.queryAllAttr":
					value = targets.map((item) =>
						typeof item.getAttribute === "function"
							? item.getAttribute(args[1])
							: null,
					);
					break;
				case "dom.queryAllProperty":
					value = targets.map((item) => item[args[1]] ?? null);
					break;
				case "dom.click":
					if (!target) {
						value = false;
						break;
					}
					target.click();
					value = true;
					break;
				case "dom.focus":
					if (!target || typeof target.focus !== "function") {
						value = false;
						break;
					}
					target.focus();
					value = true;
					break;
				case "dom.blur":
					if (!target || typeof target.blur !== "function") {
						value = false;
						break;
					}
					target.blur();
					value = true;
					break;
				case "dom.setValue":
					if (!target) {
						value = false;
						break;
					}
					target.value = args[1];
					value = true;
					break;
				case "dom.setChecked":
					if (!target) {
						value = false;
						break;
					}
					target.checked = args[1];
					value = true;
					break;
				case "dom.setSelectedIndex":
					if (!target) {
						value = false;
						break;
					}
					target.selectedIndex = args[1];
					value = true;
					break;
				case "event.dispatch":
					value = target ? target.dispatchEvent(buildFakePageEvent(spec)) : false;
					break;
				case "page.getTitle":
					value = String(document.title ?? "");
					break;
				case "page.getLocation":
					value = buildFakeLocationSnapshot();
					break;
				case "page.getReadyState":
					value = String(document.readyState ?? "");
					break;
				case "page.getVisibility":
					value = buildFakeVisibilitySnapshot();
					break;
				case "page.getSelectionText":
					value = buildFakeSelectionText();
					break;
				case "page.snapshot": {
					const [snapshotSpec] = args;
					const queryResults = Object.create(null);
					if (snapshotSpec.queries) {
						for (const [key, querySpec] of Object.entries(snapshotSpec.queries)) {
							const queryTarget = document.querySelector(querySpec.selector);
							const queryTargets = document.querySelectorAll(querySpec.selector);
							switch (querySpec.kind) {
								case "text":
									queryResults[key] = queryTarget
										? String(queryTarget.textContent ?? "")
										: null;
									break;
								case "html":
									queryResults[key] = queryTarget
										? String(queryTarget.innerHTML ?? "")
										: null;
									break;
								case "outerHtml":
									queryResults[key] = queryTarget
										? String(queryTarget.outerHTML ?? "")
										: null;
									break;
								case "attr":
									queryResults[key] =
										queryTarget && typeof queryTarget.getAttribute === "function"
											? queryTarget.getAttribute(querySpec.attribute)
											: null;
									break;
								case "property":
									queryResults[key] = queryTarget
										? queryTarget[querySpec.property] ?? null
										: null;
									break;
								case "exists":
									queryResults[key] = Boolean(queryTarget);
									break;
								case "rect":
									queryResults[key] = buildFakeRectSnapshot(queryTarget);
									break;
								case "classList":
									queryResults[key] = buildFakeClassListSnapshot(queryTarget);
									break;
								case "allText":
									queryResults[key] = queryTargets.map((item) =>
										String(item.textContent ?? ""),
									);
									break;
								case "allAttr":
									queryResults[key] = queryTargets.map((item) =>
										typeof item.getAttribute === "function"
											? item.getAttribute(querySpec.attribute)
											: null,
									);
									break;
								case "allProperty":
									queryResults[key] = queryTargets.map(
										(item) => item[querySpec.property] ?? null,
									);
									break;
								case "count":
									queryResults[key] = queryTargets.length;
									break;
								default:
									throw new Error("Unsupported page.snapshot query kind");
							}
						}
					}
					value = Object.create(null);
					if (snapshotSpec.title === true) {
						value.title = String(document.title ?? "");
					}
					if (Array.isArray(snapshotSpec.location)) {
						value.location = buildFakeLocationSnapshot(snapshotSpec.location);
					}
					if (snapshotSpec.readyState === true) {
						value.readyState = String(document.readyState ?? "");
					}
					if (snapshotSpec.visibility === true) {
						value.visibility = buildFakeVisibilitySnapshot();
					}
					if (snapshotSpec.selectionText === true) {
						value.selectionText = buildFakeSelectionText();
					}
					if (snapshotSpec.queries) {
						value.queries = queryResults;
					}
					break;
				}
				default:
					throw new Error("Unsupported page operation");
			}
			return {
				status: "fulfilled",
				result: {
					transport: "scripting.executeScript",
					ok: true,
					value,
				},
			};
		} catch (error) {
			return {
				status: "fulfilled",
				result: {
					transport: "scripting.executeScript",
					ok: false,
					error: String(error?.message || error),
				},
			};
		}
	}
	throw new Error("Unsupported page task");
}

function createDefaultBrowserMock() {
	return {
		runtime: {
			sendMessage(message) {
				return executeFakePageTask(message);
			},
		},
	};
}

async function loadApi() {
	const uniqueUrl = `${apiModuleUrl}?t=${Date.now()}_${Math.random()}`;
	const module = await import(uniqueUrl);
	return module.default;
}

async function flushMicrotasks(count = 1) {
	for (let i = 0; i < count; i++) {
		await Promise.resolve();
	}
}

async function withApi(run, options = {}) {
	const dom = installFakeDom(options.globals);
	try {
		const api = await loadApi();
		await run({ api, document: dom.document, window: dom.window });
	} finally {
		dom.restore();
	}
}

test("GM.getPageData rejects immediately with a migration error", async () => {
	const messages = [];
	await withApi(
		async ({ api, document }) => {
			await assert.rejects(
				api.getPageData(() => document.title),
				/no longer supported.*GM\.page\.call/i,
			);
			assert.equal(messages.length, 0);
			assert.equal(document.body.childNodes.length, 0);
		},
		{
			globals: {
				browser: {
					runtime: {
						async sendMessage(message) {
							messages.push(message);
							return {
								status: "fulfilled",
								result: {
									transport: "scripting.executeScript",
									ok: true,
									value: "unexpected",
								},
							};
						},
					},
				},
			},
		},
	);
});

test("uses browser-mediated transport for GM.page.call when available", async () => {
	const messages = [];
	await withApi(
		async ({ api, document }) => {
			assert.equal(await api.page.call("dom.queryText", "#target"), "from-background");
			assert.equal(messages.length, 1);
			assert.equal(messages[0].name, "API_PAGE_EXECUTE");
			assert.equal(messages[0].task.kind, "pageCall");
			assert.equal(messages[0].task.operation, "dom.queryText");
			assert.equal(messages[0].task.argsJson, '["#target"]');
			assert.equal(document.body.childNodes.length, 0);
		},
		{
			globals: {
				browser: {
					runtime: {
						async sendMessage(message) {
							messages.push(message);
							return {
								status: "fulfilled",
								result: {
									transport: "scripting.executeScript",
									ok: true,
									value: "from-background",
								},
							};
						},
					},
				},
			},
		},
	);
});

test("GM.page.call supports expanded allowlisted reads and actions", async () => {
	await withApi(
		async ({ api, document }) => {
			const realNow = Date.now;
			let nowTick = 0;
			Date.now = () => {
				nowTick += 100;
				return 1000 + nowTick;
			};
			try {
			document.title = "Expanded Surface";
			document._selectionText = "Picked text";
			const target = appendElement(document.body, "div", {
				id: "target",
				className: "card selected",
				textContent: "Launch",
				attributes: {
					"data-state": "ready",
				},
				rect: {
					x: 10,
					y: 20,
					width: 200,
					height: 50,
					top: 20,
					right: 210,
					bottom: 70,
					left: 10,
				},
			});
			target.title = "Profile link";
			const field = appendElement(document.body, "input", {
				id: "field",
				properties: {
					value: "Alpha",
					placeholder: "Search here",
				},
			});
			const checkbox = appendElement(document.body, "input", {
				id: "checkbox",
				properties: {
					checked: false,
				},
			});
			const select = appendElement(document.body, "select", {
				id: "choice",
				properties: {
					selectedIndex: 0,
				},
			});
			appendElement(document.body, "span", {
				className: "item",
				textContent: "One",
				attributes: {
					"data-id": "1",
				},
				properties: {
					title: "First",
				},
			});
			appendElement(document.body, "span", {
				className: "item",
				textContent: "Two",
				attributes: {
					"data-id": "2",
				},
				properties: {
					title: "Second",
				},
			});
			let clickCount = 0;
			target.addEventListener("click", () => {
				clickCount += 1;
			});
			assert.equal(await api.page.call("dom.exists", "#target"), true);
			assert.equal(await api.page.call("dom.exists", "#missing"), false);
			assert.equal(await api.page.call("dom.count", ".item"), 2);
			assert.equal(await api.page.call("dom.queryText", "#target"), "Launch");
			assert.equal(await api.page.call("dom.queryHtml", "#target"), "Launch");
			assert.match(
				await api.page.call("dom.queryOuterHtml", "#target"),
				/<div[^>]*>Launch<\/div>/,
			);
			assert.equal(await api.page.call("dom.queryAttr", "#target", "data-state"), "ready");
			assert.equal(await api.page.call("dom.queryAttr", "#missing", "data-state"), null);
			assert.equal(await api.page.call("dom.queryProperty", "#field", "value"), "Alpha");
			assert.equal(
				await api.page.call("dom.queryProperty", "#target", "className"),
				"card selected",
			);
			assert.equal(await api.page.call("dom.queryProperty", "#missing", "value"), null);
			const targetRect = await api.page.call("dom.queryRect", "#target");
			assert.equal(Object.getPrototypeOf(targetRect), null);
			assert.deepEqual(JSON.parse(JSON.stringify(targetRect)), {
				x: 10,
				y: 20,
				width: 200,
				height: 50,
				top: 20,
				right: 210,
				bottom: 70,
				left: 10,
			});
			assert.deepEqual(await api.page.call("dom.queryClassList", "#target"), [
				"card",
				"selected",
			]);
			assert.deepEqual(await api.page.call("dom.queryAllText", ".item"), [
				"One",
				"Two",
			]);
			assert.deepEqual(await api.page.call("dom.queryAllAttr", ".item", "data-id"), [
				"1",
				"2",
			]);
			assert.deepEqual(await api.page.call("dom.queryAllProperty", ".item", "title"), [
				"First",
				"Second",
			]);
			assert.equal(await api.page.call("dom.focus", "#field"), true);
			assert.equal(document.activeElement, field);
			assert.equal(await api.page.call("dom.blur", "#field"), true);
			assert.equal(document.activeElement, null);
			assert.equal(await api.page.call("dom.setValue", "#field", "Omega"), true);
			assert.equal(field.value, "Omega");
			assert.equal(await api.page.call("dom.setChecked", "#checkbox", true), true);
			assert.equal(checkbox.checked, true);
			assert.equal(await api.page.call("dom.setSelectedIndex", "#choice", 2), true);
			assert.equal(select.selectedIndex, 2);
			assert.equal(await api.page.call("dom.click", "#target"), true);
			assert.equal(clickCount, 1);
			assert.equal(await api.page.call("dom.click", "#missing"), false);
			assert.equal(await api.page.call("page.getTitle"), "Expanded Surface");
			const location = await api.page.call("page.getLocation");
			assert.equal(Object.getPrototypeOf(location), null);
			assert.deepEqual(JSON.parse(JSON.stringify(location)), {
				href: "https://example.test/page?tab=1#section",
				origin: "https://example.test",
				protocol: "https:",
				host: "example.test",
				hostname: "example.test",
				pathname: "/page",
				search: "?tab=1",
				hash: "#section",
			});
			assert.equal(await api.page.call("page.getReadyState"), "complete");
			const visibility = await api.page.call("page.getVisibility");
			assert.equal(Object.getPrototypeOf(visibility), null);
			assert.deepEqual(JSON.parse(JSON.stringify(visibility)), {
				hidden: false,
				visibilityState: "visible",
			});
			assert.equal(await api.page.call("page.getSelectionText"), "Picked text");
			} finally {
				Date.now = realNow;
			}
		},
	);
});

test("GM.page.call page.snapshot batches allowlisted reads", async () => {
	await withApi(async ({ api, document }) => {
		document.title = "Snapshot Title";
		document._selectionText = "Snapshot Selection";
		const status = appendElement(document.body, "div", {
			id: "status",
			className: "banner ready",
			textContent: "Ready",
			rect: {
				x: 1,
				y: 2,
				width: 300,
				height: 40,
				top: 2,
				right: 301,
				bottom: 42,
				left: 1,
			},
		});
		status.setAttribute("data-state", "warm");
		const field = appendElement(document.body, "input", {
			id: "field",
			properties: {
				value: "Beta",
			},
		});
		appendElement(document.body, "span", {
			className: "item",
			textContent: "One",
		});
		appendElement(document.body, "span", {
			className: "item",
			textContent: "Two",
		});
		const snapshot = await api.page.call("page.snapshot", {
			title: true,
			location: ["pathname", "hash"],
			readyState: true,
			visibility: true,
			selectionText: true,
			queries: {
				statusText: {
					kind: "text",
					selector: "#status",
				},
				statusHtml: {
					kind: "html",
					selector: "#status",
				},
				statusState: {
					kind: "attr",
					selector: "#status",
					attribute: "data-state",
				},
				fieldValue: {
					kind: "property",
					selector: "#field",
					property: "value",
				},
				statusRect: {
					kind: "rect",
					selector: "#status",
				},
				statusClasses: {
					kind: "classList",
					selector: "#status",
				},
				itemTexts: {
					kind: "allText",
					selector: ".item",
				},
				itemCount: {
					kind: "count",
					selector: ".item",
				},
			},
		});
		assert.equal(Object.getPrototypeOf(snapshot), null);
		assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
			title: "Snapshot Title",
			location: {
				pathname: "/page",
				hash: "#section",
			},
			readyState: "complete",
			visibility: {
				hidden: false,
				visibilityState: "visible",
			},
			selectionText: "Snapshot Selection",
			queries: {
				statusText: "Ready",
				statusHtml: "Ready",
				statusState: "warm",
				fieldValue: "Beta",
				statusRect: {
					x: 1,
					y: 2,
					width: 300,
					height: 40,
					top: 2,
					right: 301,
					bottom: 42,
					left: 1,
				},
				statusClasses: ["banner", "ready"],
				itemTexts: ["One", "Two"],
				itemCount: 2,
			},
		});
	});
});

test("GM.page.call dispatches allowlisted page events", async () => {
	await withApi(async ({ api, document }) => {
		const target = appendElement(document.body, "input", {
			id: "field",
		});
		let customDetail = null;
		target.addEventListener("userscripts:ready", (event) => {
			customDetail = event.detail;
			event.preventDefault();
		});
		const customResult = await api.page.call("event.dispatch", "#field", {
			kind: "custom",
			type: "userscripts:ready",
			bubbles: true,
			cancelable: true,
			detail: {
				step: 1,
			},
		});
		assert.equal(customResult, false);
		assert.deepEqual(customDetail, { step: 1 });

		const keyEvents = [];
		target.addEventListener("keydown", (event) => {
			keyEvents.push({
				key: event.key,
				code: event.code,
			});
		});
		const keyboardResult = await api.page.call("event.dispatch", "#field", {
			kind: "keyboard",
			type: "keydown",
			key: "A",
			code: "KeyA",
		});
		assert.equal(keyboardResult, true);
		assert.deepEqual(keyEvents, [{ key: "A", code: "KeyA" }]);
	});
});

test("GM.page.call rejects unsupported operations and invalid specs", async () => {
	await withApi(async ({ api }) => {
		await assert.rejects(
			api.page.call("dom.remove", "#target"),
			/Unsupported page operation/,
		);
		await assert.rejects(
			api.page.call("dom.queryText", ""),
			/selector must be a non-empty string/,
		);
		await assert.rejects(
			api.page.call("event.dispatch", "#target", {
				kind: "mystery",
				type: "open",
			}),
			/unsupported event kind/,
		);
		await assert.rejects(
			api.page.call("event.dispatch", "#target", {
				type: "open",
				detail: "nope",
			}),
			/event spec key is not allowed/,
		);
		await assert.rejects(
			api.page.call("dom.queryProperty", "#target", "dataset"),
			/DOM property is not allowed/,
		);
		await assert.rejects(
			api.page.call("dom.setValue", "#target", true),
			/value must be a string/,
		);
		await assert.rejects(
			api.page.call("dom.setSelectedIndex", "#target", 1.5),
			/selectedIndex must be an integer/,
		);
		await assert.rejects(
			api.page.call("page.getLocation", "extra"),
			/expects exactly 0 arguments/,
		);
		await assert.rejects(
			api.page.call("page.snapshot", {
				queries: {
					bad: {
						kind: "script",
						selector: "#target",
					},
				},
			}),
			/query kind is not allowed/,
		);
		await assert.rejects(
			api.page.call("page.snapshot", {
				unknown: true,
			}),
			/spec key is not allowed/,
		);
	});
});

test("GM.page.call enforces a per-second rate limit", async () => {
	await withApi(async ({ api, document }) => {
		appendElement(document.body, "div", {
			id: "rate-target",
			textContent: "ready",
		});
		const realNow = Date.now;
		Date.now = () => 5678;
		try {
			for (let i = 0; i < 20; i++) {
				assert.equal(
					await api.page.call("dom.queryText", "#rate-target"),
					"ready",
				);
			}
			await assert.rejects(
				api.page.call("dom.queryText", "#rate-target"),
				/rate limit exceeded/,
			);
		} finally {
			Date.now = realNow;
		}
	});
});

test("rejects malformed browser-mediated page.call payloads", async () => {
	await withApi(
		async ({ api }) => {
			await assert.rejects(
				api.page.call("dom.queryText", "#target"),
				/page\.call failed/,
			);
		},
		{
			globals: {
				browser: {
					runtime: {
						async sendMessage() {
							return {
								status: "fulfilled",
								result: {
									ok: true,
									value: "real",
								},
							};
						},
					},
				},
			},
		},
	);
});
