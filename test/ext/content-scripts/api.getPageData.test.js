import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

const apiModuleUrl = new URL(
	"../../../src/ext/content-scripts/api.js",
	import.meta.url,
).href;

class FakeEvent {
	constructor(type) {
		this.type = String(type);
		this.target = null;
	}
}

class FakeCustomEvent extends FakeEvent {
	constructor(type, init = {}) {
		super(type);
		this.detail = init.detail;
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
			entry.listener.call(this, event);
		}
		return true;
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
}

class FakeWindow {
	constructor(document) {
		this.document = document;
		this.top = this;
		this.window = this;
	}
}

function installFakeDom() {
	const previousGlobals = new Map();
	const document = new FakeDocument();
	const window = new FakeWindow(document);
	const location = { href: "https://example.test/page", origin: "https://example.test" };
	window.location = location;
	const globalAssignments = {
		Event: FakeEvent,
		CustomEvent: FakeCustomEvent,
		EventTarget: FakeEventTarget,
		Node: FakeNode,
		Element: FakeElement,
		Document: FakeDocument,
		document,
		window,
		location,
		app: undefined,
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

async function loadApi() {
	const uniqueUrl = `${apiModuleUrl}?t=${Date.now()}_${Math.random()}`;
	const module = await import(uniqueUrl);
	return module.default;
}

async function withApi(run) {
	const dom = installFakeDom();
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

test("treats spoofed response events as untrusted page data", async () => {
	await withApi(async ({ api, document }) => {
		const pending = api.getPageData(
			() =>
				new Promise(() => {
					// Keep the real extractor pending so the test controls the response.
				}),
		);
		const responseEvent = [...document._listeners.keys()].find((type) =>
			type.startsWith("__userscripts_page_data_response_"),
		);
		assert.ok(responseEvent);
		document.dispatchEvent(
			new CustomEvent(responseEvent, {
				detail: JSON.stringify({
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
