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
		this._attributes = Object.create(null);
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

	setAttribute(name, value) {
		const normalizedName = String(name);
		const normalizedValue = String(value);
		this._attributes[normalizedName] = normalizedValue;
		if (normalizedName === "id") this.id = normalizedValue;
		if (normalizedName === "class") this.className = normalizedValue;
	}

	querySelector(selector) {
		return querySelectorFrom(this, selector);
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
	const location = { href: "https://example.test/page", origin: "https://example.test" };
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
		app: undefined,
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

function appendElement(parent, tagName, options = {}) {
	const element = parent.ownerDocument.createElement(tagName);
	if (options.id) element.setAttribute("id", options.id);
	if (options.className) element.setAttribute("class", options.className);
	if (typeof options.textContent === "string") {
		element.textContent = options.textContent;
	}
	parent.appendChild(element);
	return element;
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

test("rejects unsupported page-controlled return values", async () => {
	await withApi(async ({ api }) => {
		await assert.rejects(
			api.getPageData(() => document.body),
			/object must be plain/,
		);
		await assert.rejects(api.getPageData(() => window), /object must be plain/);
		await assert.rejects(
			api.getPageData(() => () => 1),
			/unsupported type/,
		);
		await assert.rejects(
			api.getPageData(() => Infinity),
			/non-finite number|must be finite/,
		);
		await assert.rejects(
			api.getPageData(() => JSON.parse('{"__proto__":{}}')),
			/key is not allowed/,
		);
		await assert.rejects(
			api.getPageData(() => {
				const value = {};
				value.self = value;
				return value;
			}),
			/cycle/,
		);
	});
});

test("rejects oversized extractors, arguments, and results", async () => {
	await withApi(async ({ api, window }) => {
		const longExtractor = new Function(
			`return "ok"; /*${"x".repeat(110_000)}*/`,
		);
		await assert.rejects(
			api.getPageData(longExtractor),
			/extractor is too large/,
		);
		await assert.rejects(
			api.getPageData(() => null, "x".repeat(300_000)),
			/arguments are too large/,
		);
		window.bigPayload = "x".repeat(2 * 1024 * 1024 + 1);
		await assert.rejects(
			api.getPageData(() => window.bigPayload),
			/result is too large/,
		);
	});
});

test("supports async extractors and removes injected DOM after completion", async () => {
	await withApi(async ({ api, document, window }) => {
		window.app = {
			token: "token-123",
			user: {
				id: "user-42",
			},
		};
		const pending = api.getPageData(
			() =>
				new Promise((resolve) => {
					setTimeout(() => {
						resolve({
							token: window.app?.token,
							userId: window.app?.user?.id,
						});
					}, 0);
				}),
		);
		await flushMicrotasks();
		assert.equal(document.body.childNodes.length, 1);
		const result = await pending;
		assert.equal(document.body.childNodes.length, 0);
		assert.equal(Object.getPrototypeOf(result), null);
		assert.equal(result.token, "token-123");
		assert.equal(result.userId, "user-42");
	});
});

test("surfaces extractor promise rejections", async () => {
	await withApi(async ({ api }) => {
		await assert.rejects(
			api.getPageData(async () => {
				throw new Error("boom");
			}),
			/boom/,
		);
	});
});

test("enforces an active-call limit", async () => {
	await withApi(async ({ api }) => {
		globalThis.__pageDataResolvers = [];
		const pendingCalls = Array.from({ length: 8 }, (_, index) =>
			api.getPageData(
				(value) =>
					new Promise((resolve) => {
						globalThis.__pageDataResolvers.push(() => resolve(value));
					}),
				index,
			),
		);
		await assert.rejects(
			api.getPageData(() => "overflow"),
			/too many active calls/,
		);
		for (const resolve of globalThis.__pageDataResolvers.splice(0)) {
			resolve();
		}
		const results = await Promise.all(pendingCalls);
		assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7]);
		delete globalThis.__pageDataResolvers;
	});
});

test("enforces a per-second rate limit", async () => {
	await withApi(async ({ api }) => {
		const realNow = Date.now;
		Date.now = () => 1234;
		try {
			for (let i = 0; i < 20; i++) {
				assert.equal(await api.getPageData((value) => value, i), i);
			}
			await assert.rejects(
				api.getPageData(() => "overflow"),
				/rate limit exceeded/,
			);
		} finally {
			Date.now = realNow;
		}
	});
});

test("uses browser-mediated transport for getPageData when available", async () => {
	const messages = [];
	await withApi(
		async ({ api, document }) => {
			const result = await api.getPageData(() => ({
				userId: "page-value",
			}));
			assert.equal(messages.length, 1);
			assert.equal(messages[0].name, "API_PAGE_EXECUTE");
			assert.equal(messages[0].task.kind, "getPageData");
			assert.equal(messages[0].task.argsJson, "[]");
			assert.equal(document.body.childNodes.length, 0);
			assert.equal(Object.getPrototypeOf(result), null);
			assert.equal(result.userId, "from-background");
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
									value: {
										userId: "from-background",
									},
								},
							};
						},
					},
				},
			},
		},
	);
});

test("falls back to the DOM bridge when browser-mediated transport is unavailable", async () => {
	const messages = [];
	await withApi(
		async ({ api, document }) => {
			const pending = api.getPageData(
				() =>
					new Promise((resolve) => {
						setTimeout(() => resolve("fallback"), 0);
					}),
			);
			assert.equal(messages.length, 1);
			await flushMicrotasks();
			assert.equal(document.body.childNodes.length, 1);
			assert.equal(await pending, "fallback");
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
									transportUnavailable: true,
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

test("treats spoofed response events as untrusted page data", async () => {
	await withApi(async ({ api, document }) => {
		const realDispatch = document.dispatchEvent.bind(document);
		let swallowedResponseEvent = null;
		let swallowedResponseDetail = null;
		document.dispatchEvent = (event) => {
			if (String(event?.type || "").startsWith("__userscripts_page_data_response_")) {
				swallowedResponseEvent = event.type;
				swallowedResponseDetail = event.detail;
				return true;
			}
			return realDispatch(event);
		};
		const pending = api.getPageData(() => ({
			userId: "real",
		}));
		await flushMicrotasks(2);
		assert.ok(swallowedResponseEvent);
		assert.equal(typeof swallowedResponseDetail, "string");
		const capturedPayload = JSON.parse(swallowedResponseDetail);
		document.dispatchEvent = realDispatch;
		document.dispatchEvent(
			new CustomEvent(swallowedResponseEvent, {
				detail: JSON.stringify({
					id: capturedPayload.id,
					ok: true,
					value: {
						userId: "spoofed",
					},
				}),
			}),
		);
		const result = await pending;
		assert.equal(Object.getPrototypeOf(result), null);
		assert.equal(result.userId, "spoofed");
		assert.equal(document.body.childNodes.length, 0);
	});
});

test("ignores corrupted getPageData response events until a valid response arrives", async () => {
	await withApi(async ({ api, document }) => {
		const realDispatch = document.dispatchEvent.bind(document);
		let injectedCorruption = false;
		document.dispatchEvent = (event) => {
			if (
				!injectedCorruption &&
				String(event?.type || "").startsWith("__userscripts_page_data_response_")
			) {
				injectedCorruption = true;
				realDispatch(new CustomEvent(event.type, { detail: "{" }));
			}
			return realDispatch(event);
		};
		try {
			assert.equal(await api.getPageData(() => "real"), "real");
		} finally {
			document.dispatchEvent = realDispatch;
		}
	});
});

test("ignores invalid getPageData values even when the spoofed response id matches", async () => {
	await withApi(async ({ api, document }) => {
		const realDispatch = document.dispatchEvent.bind(document);
		let injectedInvalidValue = false;
		document.dispatchEvent = (event) => {
			if (
				!injectedInvalidValue &&
				String(event?.type || "").startsWith("__userscripts_page_data_response_")
			) {
				injectedInvalidValue = true;
				const payload = JSON.parse(event.detail);
				realDispatch(
					new CustomEvent(event.type, {
						detail: `{"id":${JSON.stringify(payload.id)},"ok":true,"value":{"__proto__":{}}}`,
					}),
				);
			}
			return realDispatch(event);
		};
		try {
			assert.equal(await api.getPageData(() => "real"), "real");
		} finally {
			document.dispatchEvent = realDispatch;
		}
	});
});

test("GM.page.call queries text and clicks matched elements", async () => {
	await withApi(async ({ api, document }) => {
		const target = appendElement(document.body, "button", {
			id: "target",
			textContent: "Launch",
		});
		let clickCount = 0;
		target.addEventListener("click", () => {
			clickCount += 1;
		});
		const nodeCount = document.body.childNodes.length;
		assert.equal(await api.page.call("dom.queryText", "#target"), "Launch");
		assert.equal(document.body.childNodes.length, nodeCount);
		assert.equal(await api.page.call("dom.click", "#target"), true);
		assert.equal(clickCount, 1);
		assert.equal(await api.page.call("dom.click", "#missing"), false);
		assert.equal(document.body.childNodes.length, nodeCount);
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

test("GM.page.call treats spoofed response events as untrusted page data", async () => {
	await withApi(async ({ api, document }) => {
		appendElement(document.body, "div", {
			id: "spoof-target",
			textContent: "real",
		});
		const realDispatch = document.dispatchEvent.bind(document);
		let swallowedResponseEvent = null;
		let swallowedResponseDetail = null;
		document.dispatchEvent = (event) => {
			if (String(event?.type || "").startsWith("__userscripts_page_call_response_")) {
				swallowedResponseEvent = event.type;
				swallowedResponseDetail = event.detail;
				return true;
			}
			return realDispatch(event);
		};
		const pending = api.page.call("dom.queryText", "#spoof-target");
		await flushMicrotasks(2);
		assert.ok(swallowedResponseEvent);
		assert.equal(typeof swallowedResponseDetail, "string");
		const capturedPayload = JSON.parse(swallowedResponseDetail);
		document.dispatchEvent = realDispatch;
		document.dispatchEvent(
			new CustomEvent(swallowedResponseEvent, {
				detail: JSON.stringify({
					id: capturedPayload.id,
					ok: true,
					value: "spoofed",
				}),
			}),
		);
		assert.equal(await pending, "spoofed");
	});
});

test("ignores corrupted GM.page.call response events until a valid response arrives", async () => {
	await withApi(async ({ api, document }) => {
		appendElement(document.body, "div", {
			id: "corrupt-target",
			textContent: "real",
		});
		const realDispatch = document.dispatchEvent.bind(document);
		let injectedCorruption = false;
		document.dispatchEvent = (event) => {
			if (
				!injectedCorruption &&
				String(event?.type || "").startsWith("__userscripts_page_call_response_")
			) {
				injectedCorruption = true;
				realDispatch(new CustomEvent(event.type, { detail: "{" }));
			}
			return realDispatch(event);
		};
		try {
			assert.equal(
				await api.page.call("dom.queryText", "#corrupt-target"),
				"real",
			);
		} finally {
			document.dispatchEvent = realDispatch;
		}
	});
});

test("ignores invalid GM.page.call values even when the spoofed response id matches", async () => {
	await withApi(async ({ api, document }) => {
		appendElement(document.body, "div", {
			id: "invalid-spoof-target",
			textContent: "real",
		});
		const realDispatch = document.dispatchEvent.bind(document);
		let injectedInvalidValue = false;
		document.dispatchEvent = (event) => {
			if (
				!injectedInvalidValue &&
				String(event?.type || "").startsWith("__userscripts_page_call_response_")
			) {
				injectedInvalidValue = true;
				const payload = JSON.parse(event.detail);
				realDispatch(
					new CustomEvent(event.type, {
						detail: `{"id":${JSON.stringify(payload.id)},"ok":true,"value":{"__proto__":{}}}`,
					}),
				);
			}
			return realDispatch(event);
		};
		try {
			assert.equal(
				await api.page.call("dom.queryText", "#invalid-spoof-target"),
				"real",
			);
		} finally {
			document.dispatchEvent = realDispatch;
		}
	});
});
