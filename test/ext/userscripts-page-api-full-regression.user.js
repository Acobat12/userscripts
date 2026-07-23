// ==UserScript==
// @name         Userscripts Page API Full Regression Suite
// @namespace    userscripts-debug
// @version      2.4.0
// @description  Comprehensive runtime audit for GM.getPageData(), GM.page.call(), MAIN-world transport, security, and performance.
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @grant        GM.getPageData
// @grant        GM.page.call
// ==/UserScript==

(async () => {
	"use strict";

	const SUITE = "Userscripts Page API Full Regression Suite";
	const BUILD = "2.4.0";
	const PREFIX = "[US Page API Test]";
	const FLAG_SOURCE = `${location.search}&${location.hash}`;
	const CONFIG = Object.freeze({
		strictExtended: /(?:^|[?&#])usPageApiStrict=1(?:$|[&#])/.test(FLAG_SOURCE),
		heavyPerf: /(?:^|[?&#])usPageApiPerf=1(?:$|[&#])/.test(FLAG_SOURCE),
		transportStress: /(?:^|[?&#])usPageApiStress=1(?:$|[&#])/.test(FLAG_SOURCE),
		apiMinIntervalMs: 60,
	});
	const FIXTURE_ID = `us-page-api-test-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2)}`;
	const SENTINEL = `__US_MAIN_WORLD_SENTINEL_${Date.now()}_${Math.random()
		.toString(36)
		.slice(2)}`;

	const tests = [];
	const results = [];
	const startedAt = performance.now();
	let lastApiCallAt = 0;
	let apiGate = Promise.resolve();
	const pageApiAvailability = {
		checked: false,
		value: null,
	};
	const runtimeSupport = {
		checked: false,
		value: null,
	};
	const eventDispatchSupport = {
		checked: false,
		value: null,
	};
	const localFixture = {
		root: null,
		state: null,
	};

	class SkipTest extends Error {
		constructor(message) {
			super(message);
			this.name = "SkipTest";
		}
	}

	class AbortSuiteError extends Error {
		constructor(message) {
			super(message);
			this.name = "AbortSuiteError";
		}
	}

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	function skip(message) {
		throw new SkipTest(message);
	}

	function safeObjectKeys(value) {
		if (value == null || typeof value !== "object") {
			return [];
		}
		try {
			return Object.keys(value).sort();
		} catch (error) {
			return [`<keys threw: ${String(error?.message || error)}>`];
		}
	}

	function formatDiagnosticValue(value) {
		if (Array.isArray(value)) {
			return value.length ? value.join("|") : "(none)";
		}
		if (value === null || value === undefined || value === "") {
			return "(missing)";
		}
		return String(value);
	}

	function format(value) {
		const seen = new WeakSet();
		const replacer = (_key, innerValue) => {
			if (typeof innerValue === "bigint") return `${innerValue}n`;
			if (typeof innerValue === "symbol") return String(innerValue);
			if (typeof innerValue === "function") {
				return `[Function ${innerValue.name || "anonymous"}]`;
			}
			if (innerValue && typeof innerValue === "object") {
				if (seen.has(innerValue)) return "[Circular]";
				seen.add(innerValue);
			}
			return innerValue;
		};
		if (typeof value === "string") return value;
		try {
			return JSON.stringify(value, replacer, 2);
		} catch {
			return String(value);
		}
	}

	function formatError(error) {
		if (!error) return "Unknown error";
		const name = typeof error?.name === "string" ? error.name : "";
		const message = typeof error?.message === "string" ? error.message : "";
		const stack = typeof error?.stack === "string" ? error.stack : "";
		const header = [name, message].filter(Boolean).join(": ");
		if (header && stack) {
			return stack.includes(header) ? stack : `${header}\n${stack}`;
		}
		return header || stack || String(error);
	}

	function typeTag(value) {
		if (value === null) return "null";
		if (Number.isNaN(value)) return "nan";
		if (Array.isArray(value)) return "array";
		return typeof value;
	}

	function compareDeep(actual, expected, path = "value") {
		if (Object.is(actual, expected)) return null;
		const actualType = typeTag(actual);
		const expectedType = typeTag(expected);
		if (actualType !== expectedType) {
			return `${path}: expected type ${expectedType}, got ${actualType}`;
		}
		if (actualType === "array") {
			if (actual.length !== expected.length) {
				return `${path}: expected length ${expected.length}, got ${actual.length}`;
			}
			for (let index = 0; index < actual.length; index += 1) {
				const nested = compareDeep(
					actual[index],
					expected[index],
					`${path}[${index}]`,
				);
				if (nested) return nested;
			}
			return null;
		}
		if (actualType === "object") {
			const actualKeys = Object.keys(actual).sort();
			const expectedKeys = Object.keys(expected).sort();
			const keysDiff = compareDeep(actualKeys, expectedKeys, `${path}{keys}`);
			if (keysDiff) return keysDiff;
			for (const key of actualKeys) {
				const nested = compareDeep(actual[key], expected[key], `${path}.${key}`);
				if (nested) return nested;
			}
			return null;
		}
		return `${path}: expected ${format(expected)}, got ${format(actual)}`;
	}

	function equal(actual, expected, message = "values differ") {
		const diff = compareDeep(actual, expected);
		if (diff) {
			throw new Error(
				`${message}\nDiff: ${diff}\nExpected: ${format(
					expected,
				)}\nActual: ${format(actual)}`,
			);
		}
	}

	function ok(value, message = "expected a truthy value") {
		if (!value) throw new Error(message);
	}

	function isControlFlowError(error) {
		return error instanceof SkipTest || error instanceof AbortSuiteError;
	}

	function includes(value, fragments, message = "expected text fragment was not found") {
		const text = String(value);
		const options = Array.isArray(fragments) ? fragments : [fragments];
		if (!options.some((fragment) => text.includes(fragment))) {
			throw new Error(
				`${message}\nExpected one of: ${options.join(
					", ",
				)}\nActual: ${text}`,
			);
		}
	}

	async function rejects(action, expectedMessage) {
		let caught;
		try {
			await action();
		} catch (error) {
			if (isControlFlowError(error)) {
				throw error;
			}
			caught = error;
		}
		if (!caught) {
			throw new Error(
				`Expected rejection containing: ${Array.isArray(expectedMessage) ? expectedMessage.join(", ") : expectedMessage}`,
			);
		}
		if (expectedMessage) {
			includes(caught?.message ?? caught, expectedMessage);
		}
		return caught;
	}

	function inspectPageApiAvailability() {
		const gmType = typeof GM;
		const hasGM = gmType === "object" && GM !== null;
		const gmKeys = hasGM ? safeObjectKeys(GM) : [];
		const gmInfo = hasGM && typeof GM.info === "object" && GM.info !== null
			? GM.info
			: null;
		const gmInfoScriptHandler = typeof gmInfo?.scriptHandler === "string"
			? gmInfo.scriptHandler
			: "";
		const gmInfoScriptHandlerVersion =
			typeof gmInfo?.scriptHandlerVersion === "string"
				? gmInfo.scriptHandlerVersion
				: "";
		const gmInfoVersion = typeof gmInfo?.version === "string" ? gmInfo.version : "";
		const gmInfoScript = gmInfo && typeof gmInfo.script === "object" && gmInfo.script !== null
			? gmInfo.script
			: null;
		const gmInfoScriptGrant = Array.isArray(gmInfoScript?.grant)
			? [...gmInfoScript.grant]
			: [];
		const gmInfoScriptInjectInto =
			typeof gmInfoScript?.["inject-into"] === "string"
				? gmInfoScript["inject-into"]
				: "";
		const gmGetPageDataType = hasGM ? typeof GM.getPageData : "undefined";
		const hasGetPageData = gmGetPageDataType === "function";
		const gmPageType = hasGM ? typeof GM.page : "undefined";
		const hasPage = gmPageType === "object" && GM.page !== null;
		const gmPageKeys = hasPage ? safeObjectKeys(GM.page) : [];
		const gmPageCallType = hasPage ? typeof GM.page.call : "undefined";
		const hasPageCall = gmPageCallType === "function";
		return {
			gmType,
			gmKeys,
			gmInfoScriptHandler,
			gmInfoScriptHandlerVersion,
			gmInfoVersion,
			gmInfoScriptGrant,
			gmInfoScriptInjectInto,
			gmGetPageDataType,
			gmPageType,
			gmPageKeys,
			gmPageCallType,
			hasGM,
			hasGetPageData,
			hasPage,
			hasPageCall,
			ok: hasGM && hasPage && hasPageCall,
		};
	}

	function rememberPageApiAvailability() {
		const snapshot = inspectPageApiAvailability();
		pageApiAvailability.checked = true;
		pageApiAvailability.value = snapshot;
		return snapshot;
	}

	function summarizeMissingPageApi(snapshot) {
		const missing = [];
		if (!snapshot.hasGM) missing.push("GM object");
		if (!snapshot.hasGetPageData) missing.push("GM.getPageData");
		if (!snapshot.hasPage) missing.push("GM.page");
		if (!snapshot.hasPageCall) missing.push("GM.page.call");
		return missing.length ? missing.join(", ") : "unknown page API mismatch";
	}

	function summarizePageApiDiagnostics(snapshot) {
		return [
			`typeof GM=${formatDiagnosticValue(snapshot.gmType)}`,
			`GM.keys=${formatDiagnosticValue(snapshot.gmKeys)}`,
			`GM.info.scriptHandler=${formatDiagnosticValue(
				snapshot.gmInfoScriptHandler,
			)}`,
			`GM.info.scriptHandlerVersion=${formatDiagnosticValue(
				snapshot.gmInfoScriptHandlerVersion,
			)}`,
			`GM.info.version=${formatDiagnosticValue(snapshot.gmInfoVersion)}`,
			`GM.info.script.grant=${formatDiagnosticValue(
				snapshot.gmInfoScriptGrant,
			)}`,
			`GM.info.script.inject-into=${formatDiagnosticValue(
				snapshot.gmInfoScriptInjectInto,
			)}`,
			`typeof GM.getPageData=${formatDiagnosticValue(
				snapshot.gmGetPageDataType,
			)}`,
			`typeof GM.page=${formatDiagnosticValue(snapshot.gmPageType)}`,
			`GM.page.keys=${formatDiagnosticValue(snapshot.gmPageKeys)}`,
			`typeof GM.page.call=${formatDiagnosticValue(snapshot.gmPageCallType)}`,
		].join("; ");
	}

	function ensurePageApiAvailable(operationName) {
		const snapshot = rememberPageApiAvailability();
		if (!snapshot.ok) {
			skip(
				`${operationName} unavailable in this runtime: missing ${summarizeMissingPageApi(
					snapshot,
				)}`,
			);
		}
		return snapshot;
	}

	async function probeGetPageDataSupport() {
		if (runtimeSupport.checked) {
			return runtimeSupport.value;
		}
		const snapshot = rememberPageApiAvailability();
		let value;
		if (!snapshot.hasGetPageData) {
			value = Object.freeze({
				mode: "missing",
				message: "GM.getPageData is unavailable in this runtime.",
			});
		} else {
			try {
				const result = await withApiGate(() => GM.getPageData(() => null));
				value = Object.freeze({
					mode: "supported",
					message: "GM.getPageData is available.",
					probeResult: result,
				});
			} catch (error) {
				const message = String(error?.message || error || "GM.getPageData probe failed");
				if (message.includes("no longer supported")) {
					value = Object.freeze({
						mode: "deprecated",
						message,
					});
				} else {
					value = Object.freeze({
						mode: "runtime-error",
						message,
						error,
					});
				}
			}
		}
		runtimeSupport.checked = true;
		runtimeSupport.value = value;
		return value;
	}

	async function ensureGetPageDataSupported(operationName = "GM.getPageData") {
		const support = await probeGetPageDataSupport();
		if (support.mode === "supported") {
			return support;
		}
		if (support.mode === "deprecated" || support.mode === "missing") {
			skip(`${operationName} incompatible with current Userscripts runtime: ${support.message}`);
		}
		throw new Error(`${operationName} runtime probe failed: ${support.message}`);
	}

	function isKnownEventDispatchRuntimeFailure(error) {
		const text = formatError(error);
		return (
			text.includes("executeScript") ||
			text.includes("safari-web-extension://") ||
			text.includes("webkit-masked-url://hidden/")
		);
	}

	function group(name, fn) {
		currentGroup.push(name);
		try {
			fn();
		} finally {
			currentGroup.pop();
		}
	}

	function test(name, fn, options = {}) {
		tests.push({
			name,
			fn,
			group: [...currentGroup],
			optional: Boolean(options.optional),
			heavy: Boolean(options.heavy),
			tags: Array.isArray(options.tags) ? [...options.tags] : [],
		});
	}

	async function withApiGate(action) {
		const previous = apiGate;
		let release;
		apiGate = new Promise((resolve) => {
			release = resolve;
		});
		await previous;
		const delta = performance.now() - lastApiCallAt;
		if (delta < CONFIG.apiMinIntervalMs) {
			await sleep(CONFIG.apiMinIntervalMs - delta);
		}
		try {
			return await action();
		} finally {
			lastApiCallAt = performance.now();
			release();
		}
	}

	async function gmGetPageData(extractor, ...args) {
		await ensureGetPageDataSupported("GM.getPageData");
		return withApiGate(() => GM.getPageData(extractor, ...args));
	}

	async function gmPageCall(operation, ...args) {
		ensurePageApiAvailable("GM.page.call");
		return withApiGate(() => GM.page.call(operation, ...args));
	}

	async function rawGetPageData(extractor, ...args) {
		await ensureGetPageDataSupported("GM.getPageData");
		return GM.getPageData(extractor, ...args);
	}

	async function rawPageCall(operation, ...args) {
		ensurePageApiAvailable("GM.page.call");
		return GM.page.call(operation, ...args);
	}

	async function probeEventDispatchSupport() {
		if (eventDispatchSupport.checked) {
			return eventDispatchSupport.value;
		}
		let value;
		try {
			value = Object.freeze({
				mode: "supported",
				message: "event.dispatch is available.",
				probeResult: await gmPageCall(
					"event.dispatch",
					selectorFor(`${FIXTURE_ID}-missing`),
					{
						kind: "event",
						type: "us-basic-event",
					},
				),
			});
		} catch (error) {
			if (isKnownEventDispatchRuntimeFailure(error)) {
				value = Object.freeze({
					mode: "runtime-error",
					message: formatError(error),
					error,
				});
			} else {
				throw error;
			}
		}
		eventDispatchSupport.checked = true;
		eventDispatchSupport.value = value;
		return value;
	}

	async function ensureEventDispatchSupported(operationName = "event.dispatch") {
		const support = await probeEventDispatchSupport();
		if (support.mode === "supported") {
			return support;
		}
		throw new Error(
			`${operationName} incompatible with current Safari runtime: ${support.message}`,
		);
	}

	async function gmEventDispatch(selector, spec) {
		await ensureEventDispatchSupported("GM.page.call event.dispatch");
		return gmPageCall("event.dispatch", selector, spec);
	}

	function selectorFor(id) {
		return `#${CSS.escape(id)}`;
	}

	function installReportPanel() {
		const panel = document.createElement("section");
		panel.id = `${FIXTURE_ID}-report`;
		Object.assign(panel.style, {
			position: "fixed",
			right: "12px",
			bottom: "12px",
			zIndex: "2147483647",
			width: "min(860px, calc(100vw - 24px))",
			maxHeight: "75vh",
			overflow: "auto",
			padding: "12px",
			border: "1px solid #666",
			borderRadius: "10px",
			background: "Canvas",
			color: "CanvasText",
			font: "12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace",
			boxShadow: "0 4px 24px rgba(0,0,0,.25)",
		});
		panel.innerHTML = `
			<div style="display:flex;gap:8px;align-items:center">
				<strong style="flex:1">${SUITE}</strong>
				<button type="button" data-action="copy">Copy</button>
				<button type="button" data-action="close">×</button>
			</div>
			<div data-role="meta" style="margin-top:8px;opacity:.8"></div>
			<div data-role="summary" style="margin-top:8px">Running…</div>
			<div data-role="active" style="margin-top:6px;opacity:.85">Waiting for first test…</div>
			<div style="margin-top:10px;font-weight:bold">Live stream</div>
			<pre data-role="stream" style="white-space:pre-wrap;margin:6px 0 0;max-height:30vh;overflow:auto;padding:8px;border:1px solid #555;border-radius:6px;background:rgba(127,127,127,.08)">No test results yet.</pre>
			<details data-role="report-wrap" style="margin-top:10px">
				<summary style="cursor:pointer">Full report</summary>
				<pre data-role="report" style="white-space:pre-wrap;margin:8px 0 0"></pre>
			</details>
		`;
		panel.querySelector('[data-action="close"]').addEventListener("click", () => {
			panel.remove();
		});
		panel.querySelector('[data-action="copy"]').addEventListener("click", async () => {
			const reportText = panel.querySelector('[data-role="report"]').textContent;
			const streamText = panel.querySelector('[data-role="stream"]').textContent;
			const text = reportText || streamText;
			try {
				await navigator.clipboard.writeText(text);
			} catch {
				console.log(text);
			}
		});
		panel.querySelector('[data-role="meta"]').textContent = [
			`version=${BUILD}`,
			`strictExtended=${CONFIG.strictExtended ? 1 : 0}`,
			`heavyPerf=${CONFIG.heavyPerf ? 1 : 0}`,
			`transportStress=${CONFIG.transportStress ? 1 : 0}`,
		].join(" | ");
		document.documentElement.append(panel);
		return panel;
	}

	function currentGroupLabel(groupPath) {
		return groupPath.join(" / ");
	}

	function renderInterim(panel, activeName = "Running…") {
		const completed = results.length;
		panel.querySelector('[data-role="summary"]').textContent = `${completed}/${tests.length} complete | ${activeName}`;
		panel.querySelector('[data-role="active"]').textContent = activeName;
		const stream = panel.querySelector('[data-role="stream"]');
		stream.textContent = results.length
			? results
			.slice(-25)
			.map((item, index) => {
				const line = `${String(completed - Math.min(24, completed) + index + 1).padStart(3, "0")}. ${item.status} [${currentGroupLabel(item.group)}] ${item.name} (${item.duration.toFixed(1)} ms)`;
				if (!item.error && !item.detail) return line;
				return [line, item.detail, item.error].filter(Boolean).join("\n");
			})
			.join("\n\n")
			: "No test results yet.";
		stream.scrollTop = stream.scrollHeight;
	}

	function buildLiveReport(summary = "Running…") {
		const passed = results.filter((item) => item.status === "PASS").length;
		const failed = results.filter((item) => item.status === "FAIL").length;
		const warned = results.filter((item) => item.status === "WARN").length;
		const skipped = results.filter((item) => item.status === "SKIP").length;
		return Object.freeze({
			summary,
			passed,
			failed,
			warned,
			skipped,
			duration: performance.now() - startedAt,
			config: Object.freeze({ ...CONFIG }),
			build: BUILD,
			pageApiAvailability: pageApiAvailability.value
				? Object.freeze({ ...pageApiAvailability.value })
				: null,
			runtimeSupport: runtimeSupport.value
				? Object.freeze({ ...runtimeSupport.value })
				: null,
			results: Object.freeze(results.map((item) => Object.freeze({ ...item }))),
		});
	}

	function publishLiveReport(summary = "Running…") {
		globalThis.__US_PAGE_API_TEST_REPORT__ = buildLiveReport(summary);
	}

	function ensureLocalFixtureState() {
		if (!localFixture.state || !localFixture.root?.isConnected) {
			throw new Error("Local page.call fixture is not initialized");
		}
		return localFixture.state;
	}

	async function localFixtureMeta() {
		const state = ensureLocalFixtureState();
		return {
			realm: state.realm,
			weirdId: state.weirdId,
			iframes: { ...state.iframes },
			closedShadowMode: state.closedShadowMode,
			openShadowButtonId: state.openShadowButtonId,
			closedShadowButtonId: state.closedShadowButtonId,
		};
	}

	async function resetLocalFixtureState() {
		const state = ensureLocalFixtureState();
		state.clicks.length = 0;
		state.events.length = 0;
		state.sideEffectHits.length = 0;
		return true;
	}

	async function localClickLog() {
		return ensureLocalFixtureState().clicks.slice();
	}

	async function lastLocalClick() {
		const clicks = await localClickLog();
		return clicks.at(-1) ?? null;
	}

	async function lastLocalEvent() {
		const events = ensureLocalFixtureState().events;
		return events.at(-1) ?? null;
	}

	async function localSideEffectHits() {
		return ensureLocalFixtureState().sideEffectHits.slice();
	}

	async function waitForLocalFrame(iframe) {
		return new Promise((resolve) => {
			const done = (status) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				iframe.removeEventListener("load", onload);
				iframe.removeEventListener("error", onerror);
				resolve(status);
			};
			let settled = false;
			const onload = () => done("load");
			const onerror = () => done("error");
			const timer = setTimeout(() => done("timeout"), 1200);
			iframe.addEventListener("load", onload, { once: true });
			iframe.addEventListener("error", onerror, { once: true });
			try {
				const ready = iframe.contentDocument?.readyState;
				if (
					ready === "interactive" ||
					ready === "complete" ||
					(iframe.srcdoc && iframe.contentDocument)
				) {
					done("ready");
				}
			} catch {
				// opaque frame access is expected for some variants
			}
		});
	}

	async function setupLocalFixture() {
		await cleanupLocalFixture();

		const root = document.createElement("div");
		root.id = FIXTURE_ID;
		root.style.cssText =
			"position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";

		const weirdId = `${FIXTURE_ID}:weird.id?node`;

		const text = document.createElement("div");
		text.id = `${FIXTURE_ID}-text`;
		text.textContent = "MAIN world text ✓";

		const weird = document.createElement("div");
		weird.id = weirdId;
		weird.textContent = "Escaped selector text";

		const button = document.createElement("button");
		button.id = `${FIXTURE_ID}-button`;
		button.textContent = "Click test";

		const hiddenButton = document.createElement("button");
		hiddenButton.id = `${FIXTURE_ID}-button-hidden`;
		hiddenButton.style.visibility = "hidden";
		hiddenButton.textContent = "Hidden button";

		const displayNoneButton = document.createElement("button");
		displayNoneButton.id = `${FIXTURE_ID}-button-display-none`;
		displayNoneButton.style.display = "none";
		displayNoneButton.textContent = "Display none button";

		const pointerNoneButton = document.createElement("button");
		pointerNoneButton.id = `${FIXTURE_ID}-button-pointer-none`;
		pointerNoneButton.style.pointerEvents = "none";
		pointerNoneButton.textContent = "Pointer none button";

		const disabledButton = document.createElement("button");
		disabledButton.id = `${FIXTURE_ID}-button-disabled`;
		disabledButton.disabled = true;
		disabledButton.textContent = "Disabled button";

		const input = document.createElement("input");
		input.id = `${FIXTURE_ID}-input`;
		input.value = "fixture input";
		input.name = "fixture-input";
		input.placeholder = "fixture placeholder";

		const textarea = document.createElement("textarea");
		textarea.id = `${FIXTURE_ID}-textarea`;
		textarea.value = "fixture textarea";

		const fileInput = document.createElement("input");
		fileInput.id = `${FIXTURE_ID}-file-input`;
		fileInput.type = "file";

		const eventTarget = document.createElement("div");
		eventTarget.id = `${FIXTURE_ID}-event-target`;

		const htmlTarget = document.createElement("div");
		htmlTarget.id = `${FIXTURE_ID}-html`;
		htmlTarget.className = `${FIXTURE_ID}-class alpha beta`;
		htmlTarget.setAttribute("data-state", "ready");
		htmlTarget.innerHTML =
			"<span data-kind='label'>Alpha</span><strong>Beta</strong>";

		const checkbox = document.createElement("input");
		checkbox.id = `${FIXTURE_ID}-checkbox`;
		checkbox.type = "checkbox";
		checkbox.checked = false;

		const select = document.createElement("select");
		select.id = `${FIXTURE_ID}-select`;
		for (const label of ["First", "Second", "Third"]) {
			const option = document.createElement("option");
			option.textContent = label;
			select.append(option);
		}
		select.selectedIndex = 1;

		const itemClass = `${FIXTURE_ID}-item`;
		const itemOne = document.createElement("span");
		itemOne.id = `${FIXTURE_ID}-item-1`;
		itemOne.className = itemClass;
		itemOne.textContent = "Item Alpha";
		itemOne.setAttribute("data-rank", "1");
		itemOne.title = "Item title alpha";

		const itemTwo = document.createElement("span");
		itemTwo.id = `${FIXTURE_ID}-item-2`;
		itemTwo.className = itemClass;
		itemTwo.textContent = "Item Beta";
		itemTwo.setAttribute("data-rank", "2");
		itemTwo.title = "Item title beta";

		const form = document.createElement("form");
		form.id = `${FIXTURE_ID}-form`;
		const submitButton = document.createElement("button");
		submitButton.id = `${FIXTURE_ID}-submitter`;
		submitButton.type = "submit";
		submitButton.textContent = "Submit";
		form.append(submitButton);

		const details = document.createElement("details");
		details.id = `${FIXTURE_ID}-details`;
		details.open = true;
		const summary = document.createElement("summary");
		summary.textContent = "Toggle me";
		details.append(summary, document.createTextNode("Details body"));

		const svgNs = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(svgNs, "svg");
		svg.setAttribute("viewBox", "0 0 10 10");
		const svgText = document.createElementNS(svgNs, "text");
		svgText.id = `${FIXTURE_ID}-svg-text`;
		svgText.textContent = "SVG text";
		svg.append(svgText);

		const mathNs = "http://www.w3.org/1998/Math/MathML";
		const math = document.createElementNS(mathNs, "math");
		const mtext = document.createElementNS(mathNs, "mtext");
		mtext.id = `${FIXTURE_ID}-math-text`;
		mtext.textContent = "MathML text";
		math.append(mtext);

		const openShadowHost = document.createElement("div");
		openShadowHost.id = `${FIXTURE_ID}-shadow-host-open`;
		const openShadowRoot = openShadowHost.attachShadow({ mode: "open" });
		const openShadowText = document.createElement("span");
		openShadowText.id = `${FIXTURE_ID}-shadow-open-text`;
		openShadowText.textContent = "Open shadow text";
		const openShadowButton = document.createElement("button");
		openShadowButton.id = `${FIXTURE_ID}-shadow-open-button`;
		openShadowButton.textContent = "Open shadow button";
		openShadowRoot.append(openShadowText, openShadowButton);

		const closedShadowHost = document.createElement("div");
		closedShadowHost.id = `${FIXTURE_ID}-shadow-host-closed`;
		const closedShadowRoot = closedShadowHost.attachShadow({ mode: "closed" });
		const closedShadowText = document.createElement("span");
		closedShadowText.id = `${FIXTURE_ID}-shadow-closed-text`;
		closedShadowText.textContent = "Closed shadow text";
		const closedShadowButton = document.createElement("button");
		closedShadowButton.id = `${FIXTURE_ID}-shadow-closed-button`;
		closedShadowButton.textContent = "Closed shadow button";
		closedShadowRoot.append(closedShadowText, closedShadowButton);

		const aboutBlankFrame = document.createElement("iframe");
		aboutBlankFrame.id = `${FIXTURE_ID}-iframe-about-blank`;
		aboutBlankFrame.src = "about:blank";

		const srcdocFrame = document.createElement("iframe");
		srcdocFrame.id = `${FIXTURE_ID}-iframe-srcdoc`;
		srcdocFrame.srcdoc =
			"<!doctype html><html><body><div id='frame-srcdoc-text'>srcdoc frame text</div></body></html>";

		const sandboxFrame = document.createElement("iframe");
		sandboxFrame.id = `${FIXTURE_ID}-iframe-sandbox`;
		sandboxFrame.setAttribute("sandbox", "allow-scripts");
		sandboxFrame.srcdoc =
			"<!doctype html><html><body><div id='frame-sandbox-text'>sandbox frame text</div></body></html>";

		const dataFrame = document.createElement("iframe");
		dataFrame.id = `${FIXTURE_ID}-iframe-data`;
		dataFrame.src =
			"data:text/html,%3C!doctype%20html%3E%3Chtml%3E%3Cbody%3E%3Cdiv%20id%3D%22frame-data-text%22%3Edata%20frame%20text%3C/div%3E%3C/body%3E%3C/html%3E";

		root.append(
			text,
			weird,
			button,
			hiddenButton,
			displayNoneButton,
			pointerNoneButton,
			disabledButton,
			input,
			textarea,
			fileInput,
			eventTarget,
			htmlTarget,
			checkbox,
			select,
			itemOne,
			itemTwo,
			form,
			details,
			svg,
			math,
			openShadowHost,
			closedShadowHost,
			aboutBlankFrame,
			srcdocFrame,
			sandboxFrame,
			dataFrame,
		);
		document.documentElement.append(root);

		await Promise.all([
			waitForLocalFrame(aboutBlankFrame),
			waitForLocalFrame(srcdocFrame),
			waitForLocalFrame(sandboxFrame),
			waitForLocalFrame(dataFrame),
		]);

		try {
			aboutBlankFrame.contentDocument.open();
			aboutBlankFrame.contentDocument.write(
				"<!doctype html><html><body><div id='frame-about-text'>about:blank frame text</div></body></html>",
			);
			aboutBlankFrame.contentDocument.close();
		} catch {
			// ignore if browser prevents mutation during load
		}

		const state = {
			realm: "content",
			weirdId,
			clicks: [],
			events: [],
			sideEffectHits: [],
			iframes: {
				aboutBlankId: aboutBlankFrame.id,
				srcdocId: srcdocFrame.id,
				sandboxId: sandboxFrame.id,
				dataId: dataFrame.id,
				aboutBlankAccessible: Boolean(
					aboutBlankFrame.contentDocument?.getElementById("frame-about-text"),
				),
				srcdocAccessible: Boolean(
					srcdocFrame.contentDocument?.getElementById("frame-srcdoc-text"),
				),
				sandboxOpaque: false,
				dataOpaque: false,
			},
			closedShadowMode: "closed",
			openShadowButtonId: openShadowButton.id,
			closedShadowButtonId: closedShadowButton.id,
		};

		const recordClick = (label) => (event) => {
			state.clicks.push({
				label,
				type: event.type,
				targetId: event.currentTarget?.id ?? null,
				isTrusted: event.isTrusted,
			});
		};

		for (const [label, node] of [
			["button", button],
			["hidden", hiddenButton],
			["displayNone", displayNoneButton],
			["pointerNone", pointerNoneButton],
			["disabled", disabledButton],
			["shadowOpen", openShadowButton],
			["shadowClosed", closedShadowButton],
		]) {
			node.addEventListener("click", recordClick(label));
		}

		const eventTypes = [
			"us-basic-event",
			"us-custom-event",
			"mousedown",
			"keydown",
			"input",
			"beforeinput",
			"pointerdown",
			"focusin",
			"wheel",
			"clipboardcopy",
			"dragstart",
			"compositionstart",
			"submit",
			"toggle",
			"transitionend",
			"animationend",
			"hashchange",
			"popstate",
			"storage",
			"pageshow",
			"us-cancelled-event",
		];

		const recordEvent = (event) => {
			const entry = {
				type: event.type,
				constructorName: event.constructor?.name || "",
				targetId: event.currentTarget?.id ?? null,
				bubbles: Boolean(event.bubbles),
				cancelable: Boolean(event.cancelable),
				composed: Boolean(event.composed),
				defaultPrevented: Boolean(event.defaultPrevented),
			};
			for (const numericKey of [
				"button",
				"buttons",
				"clientX",
				"clientY",
				"location",
				"deltaX",
				"deltaY",
				"deltaZ",
				"deltaMode",
				"pointerId",
				"elapsedTime",
			]) {
				if (typeof event[numericKey] === "number") {
					entry[numericKey] = event[numericKey];
				}
			}
			for (const stringKey of [
				"key",
				"code",
				"data",
				"inputType",
				"pointerType",
				"propertyName",
				"animationName",
				"pseudoElement",
				"oldURL",
				"newURL",
				"oldValue",
				"newValue",
			]) {
				if (typeof event[stringKey] === "string") {
					entry[stringKey] = event[stringKey];
				}
			}
			for (const booleanKey of [
				"repeat",
				"shiftKey",
				"ctrlKey",
				"altKey",
				"metaKey",
				"isComposing",
				"isPrimary",
				"persisted",
			]) {
				if (typeof event[booleanKey] === "boolean") {
					entry[booleanKey] = event[booleanKey];
				}
			}
			if (event instanceof CustomEvent) entry.detail = event.detail;
			if ("state" in event && event.state !== undefined) {
				entry.state = event.state;
			}
			if ("submitter" in event) {
				entry.submitterId = event.submitter?.id ?? null;
			}
			if ("relatedTarget" in event) {
				entry.relatedTargetId = event.relatedTarget?.id ?? null;
			}
			if ("clipboardData" in event) {
				entry.hasClipboardData = Boolean(event.clipboardData);
			}
			if ("dataTransfer" in event) {
				entry.hasDataTransfer = Boolean(event.dataTransfer);
			}
			if (event instanceof StorageEvent) {
				entry.storageKey = event.key;
			}
			state.events.push(entry);
		};

		for (const type of eventTypes) {
			eventTarget.addEventListener(type, recordEvent);
			form.addEventListener(type, recordEvent);
			details.addEventListener(type, recordEvent);
		}
		eventTarget.addEventListener("us-cancelled-event", (event) => {
			event.preventDefault();
		});

		try {
			void sandboxFrame.contentDocument?.body;
		} catch {
			state.iframes.sandboxOpaque = true;
		}
		try {
			void dataFrame.contentDocument?.body;
		} catch {
			state.iframes.dataOpaque = true;
		}

		localFixture.root = root;
		localFixture.state = state;

		return {
			fixtureCreated: Boolean(document.getElementById(FIXTURE_ID)),
			fixtureRealm: state.realm,
			documentType: document.constructor.name,
			weirdId,
			iframes: { ...state.iframes },
		};
	}

	async function cleanupLocalFixture() {
		localFixture.root?.remove();
		localFixture.root = null;
		localFixture.state = null;
		return {
			fixturePresent: Boolean(document.getElementById(FIXTURE_ID)),
			sentinelPresent: false,
		};
	}

	async function pageState() {
		return gmGetPageData((sentinelName) => {
			return window[sentinelName]?.snapshot?.() ?? null;
		}, SENTINEL);
	}

	async function resetPageState() {
		return gmGetPageData((sentinelName) => {
			return window[sentinelName]?.resetRuntimeState?.() ?? false;
		}, SENTINEL);
	}

	async function pageHasConstructor(name) {
		return gmGetPageData((ctorName) => typeof window[ctorName] === "function", name);
	}

	async function installBridgeTraps() {
		return gmGetPageData((sentinelName) => {
			return window[sentinelName]?.installBridgeTraps?.() ?? null;
		}, SENTINEL);
	}

	async function restoreBridgeTraps() {
		return gmGetPageData((sentinelName) => {
			return window[sentinelName]?.restoreBridgeTraps?.() ?? null;
		}, SENTINEL);
	}

	async function bridgeTrapHits() {
		return gmGetPageData((sentinelName) => {
			return window[sentinelName]?.snapshot?.().bridgeTrapHits ?? [];
		}, SENTINEL);
	}

	async function lastEvent() {
		return gmGetPageData((sentinelName) => {
			const events = window[sentinelName]?.snapshot?.().events ?? [];
			return events.at(-1) ?? null;
		}, SENTINEL);
	}

	async function clickLog() {
		return gmGetPageData((sentinelName) => {
			return window[sentinelName]?.snapshot?.().clicks ?? [];
		}, SENTINEL);
	}

	async function lastClick() {
		const clicks = await clickLog();
		return clicks.at(-1) ?? null;
	}

	async function sideEffectHits() {
		return gmGetPageData((sentinelName) => {
			return window[sentinelName]?.snapshot?.().sideEffectHits ?? [];
		}, SENTINEL);
	}

	async function fixtureMeta() {
		return gmGetPageData((sentinelName) => {
			const state = window[sentinelName];
			if (!state) return null;
			return {
				realm: state.realm,
				weirdId: state.weirdId,
				iframes: state.iframes,
				closedShadowMode: state.closedShadowMode,
				openShadowButtonId: state.openShadowButtonId,
				closedShadowButtonId: state.closedShadowButtonId,
			};
		}, SENTINEL);
	}

	async function withTransportTrapAssertions(name, action) {
		await resetPageState();
		await installBridgeTraps();
		try {
			await action();
		} finally {
			await restoreBridgeTraps();
		}
		const hits = await bridgeTrapHits();
		equal(hits, [], `${name} used a forbidden bridge primitive`);
	}

	async function setupMainWorldFixture() {
		return gmGetPageData(async (fixtureId, sentinelName) => {
			const oldRoot = document.getElementById(fixtureId);
			oldRoot?.remove();
			const oldState = window[sentinelName];
			try {
				oldState?.restoreBridgeTraps?.();
			} catch {
				// ignore stale trap cleanup
			}
			delete window[sentinelName];

			const root = document.createElement("div");
			root.id = fixtureId;
			root.style.cssText =
				"position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";

			const weirdId = `${fixtureId}:weird.id?node`;

			const text = document.createElement("div");
			text.id = `${fixtureId}-text`;
			text.textContent = "MAIN world text ✓";

			const weird = document.createElement("div");
			weird.id = weirdId;
			weird.textContent = "Escaped selector text";

			const button = document.createElement("button");
			button.id = `${fixtureId}-button`;
			button.textContent = "Click test";

			const hiddenButton = document.createElement("button");
			hiddenButton.id = `${fixtureId}-button-hidden`;
			hiddenButton.style.visibility = "hidden";
			hiddenButton.textContent = "Hidden button";

			const displayNoneButton = document.createElement("button");
			displayNoneButton.id = `${fixtureId}-button-display-none`;
			displayNoneButton.style.display = "none";
			displayNoneButton.textContent = "Display none button";

			const pointerNoneButton = document.createElement("button");
			pointerNoneButton.id = `${fixtureId}-button-pointer-none`;
			pointerNoneButton.style.pointerEvents = "none";
			pointerNoneButton.textContent = "Pointer none button";

			const disabledButton = document.createElement("button");
			disabledButton.id = `${fixtureId}-button-disabled`;
			disabledButton.disabled = true;
			disabledButton.textContent = "Disabled button";

			const input = document.createElement("input");
			input.id = `${fixtureId}-input`;
			input.value = "fixture input";

			const textarea = document.createElement("textarea");
			textarea.id = `${fixtureId}-textarea`;
			textarea.value = "fixture textarea";

			const fileInput = document.createElement("input");
			fileInput.id = `${fixtureId}-file-input`;
			fileInput.type = "file";

			const eventTarget = document.createElement("div");
			eventTarget.id = `${fixtureId}-event-target`;

			const form = document.createElement("form");
			form.id = `${fixtureId}-form`;
			const submitButton = document.createElement("button");
			submitButton.id = `${fixtureId}-submitter`;
			submitButton.type = "submit";
			submitButton.textContent = "Submit";
			form.append(submitButton);

			const details = document.createElement("details");
			details.id = `${fixtureId}-details`;
			details.open = true;
			const summary = document.createElement("summary");
			summary.textContent = "Toggle me";
			details.append(summary, document.createTextNode("Details body"));

			const svgNs = "http://www.w3.org/2000/svg";
			const svg = document.createElementNS(svgNs, "svg");
			svg.setAttribute("viewBox", "0 0 10 10");
			const svgText = document.createElementNS(svgNs, "text");
			svgText.id = `${fixtureId}-svg-text`;
			svgText.textContent = "SVG text";
			svg.append(svgText);

			const mathNs = "http://www.w3.org/1998/Math/MathML";
			const math = document.createElementNS(mathNs, "math");
			const mtext = document.createElementNS(mathNs, "mtext");
			mtext.id = `${fixtureId}-math-text`;
			mtext.textContent = "MathML text";
			math.append(mtext);

			const openShadowHost = document.createElement("div");
			openShadowHost.id = `${fixtureId}-shadow-host-open`;
			const openShadowRoot = openShadowHost.attachShadow({ mode: "open" });
			const openShadowText = document.createElement("span");
			openShadowText.id = `${fixtureId}-shadow-open-text`;
			openShadowText.textContent = "Open shadow text";
			const openShadowButton = document.createElement("button");
			openShadowButton.id = `${fixtureId}-shadow-open-button`;
			openShadowButton.textContent = "Open shadow button";
			openShadowRoot.append(openShadowText, openShadowButton);

			const closedShadowHost = document.createElement("div");
			closedShadowHost.id = `${fixtureId}-shadow-host-closed`;
			const closedShadowRoot = closedShadowHost.attachShadow({ mode: "closed" });
			const closedShadowText = document.createElement("span");
			closedShadowText.id = `${fixtureId}-shadow-closed-text`;
			closedShadowText.textContent = "Closed shadow text";
			const closedShadowButton = document.createElement("button");
			closedShadowButton.id = `${fixtureId}-shadow-closed-button`;
			closedShadowButton.textContent = "Closed shadow button";
			closedShadowRoot.append(closedShadowText, closedShadowButton);

			const aboutBlankFrame = document.createElement("iframe");
			aboutBlankFrame.id = `${fixtureId}-iframe-about-blank`;
			aboutBlankFrame.src = "about:blank";

			const srcdocFrame = document.createElement("iframe");
			srcdocFrame.id = `${fixtureId}-iframe-srcdoc`;
			srcdocFrame.srcdoc =
				"<!doctype html><html><body><div id='frame-srcdoc-text'>srcdoc frame text</div></body></html>";

			const sandboxFrame = document.createElement("iframe");
			sandboxFrame.id = `${fixtureId}-iframe-sandbox`;
			sandboxFrame.setAttribute("sandbox", "allow-scripts");
			sandboxFrame.srcdoc =
				"<!doctype html><html><body><div id='frame-sandbox-text'>sandbox frame text</div></body></html>";

			const dataFrame = document.createElement("iframe");
			dataFrame.id = `${fixtureId}-iframe-data`;
			dataFrame.src =
				"data:text/html,%3C!doctype%20html%3E%3Chtml%3E%3Cbody%3E%3Cdiv%20id%3D%22frame-data-text%22%3Edata%20frame%20text%3C/div%3E%3C/body%3E%3C/html%3E";

			root.append(
				text,
				weird,
				button,
				hiddenButton,
				displayNoneButton,
				pointerNoneButton,
				disabledButton,
				input,
				textarea,
				fileInput,
				eventTarget,
				form,
				details,
				svg,
				math,
				openShadowHost,
				closedShadowHost,
				aboutBlankFrame,
				srcdocFrame,
				sandboxFrame,
				dataFrame,
			);
			document.documentElement.append(root);

			const waitForFrame = (iframe) =>
				new Promise((resolve) => {
					const done = (state) => {
						if (resolved) return;
						resolved = true;
						clearTimeout(timer);
						iframe.removeEventListener("load", onload);
						iframe.removeEventListener("error", onerror);
						resolve(state);
					};
					let resolved = false;
					const onload = () => done("load");
					const onerror = () => done("error");
					const timer = setTimeout(() => done("timeout"), 1200);
					iframe.addEventListener("load", onload, { once: true });
					iframe.addEventListener("error", onerror, { once: true });
					try {
						const ready = iframe.contentDocument?.readyState;
						if (
							ready === "interactive" ||
							ready === "complete" ||
							(iframe.srcdoc && iframe.contentDocument)
						) {
							done("ready");
						}
					} catch {
						// opaque frame access is expected for some cases
					}
				});

			await Promise.all([
				waitForFrame(aboutBlankFrame),
				waitForFrame(srcdocFrame),
				waitForFrame(sandboxFrame),
				waitForFrame(dataFrame),
			]);

			try {
				aboutBlankFrame.contentDocument.open();
				aboutBlankFrame.contentDocument.write(
					"<!doctype html><html><body><div id='frame-about-text'>about:blank frame text</div></body></html>",
				);
				aboutBlankFrame.contentDocument.close();
			} catch {
				// ignore if browser prevents mutation during load
			}

			const eventTypes = [
				"us-basic-event",
				"us-custom-event",
				"mousedown",
				"keydown",
				"input",
				"beforeinput",
				"pointerdown",
				"focusin",
				"wheel",
				"clipboardcopy",
				"dragstart",
				"compositionstart",
				"submit",
				"toggle",
				"transitionend",
				"animationend",
				"hashchange",
				"popstate",
				"storage",
				"pageshow",
				"us-cancelled-event",
			];

			const state = {
				realm: "MAIN",
				createdAt: Date.now(),
				weirdId,
				clicks: [],
				events: [],
				bridgeTrapHits: [],
				sideEffectHits: [],
				detachedClicks: 0,
				closedShadowClicks: 0,
				counter: 0,
				iframes: {
					aboutBlankId: aboutBlankFrame.id,
					srcdocId: srcdocFrame.id,
					sandboxId: sandboxFrame.id,
					dataId: dataFrame.id,
					aboutBlankAccessible: Boolean(
						aboutBlankFrame.contentDocument?.getElementById("frame-about-text"),
					),
					srcdocAccessible: Boolean(
						srcdocFrame.contentDocument?.getElementById("frame-srcdoc-text"),
					),
					sandboxOpaque: false,
					dataOpaque: false,
				},
				closedShadowMode: "closed",
				openShadowButtonId: openShadowButton.id,
				closedShadowButtonId: closedShadowButton.id,
				snapshot() {
					return {
						realm: this.realm,
						createdAt: this.createdAt,
						weirdId: this.weirdId,
						clicks: this.clicks.slice(),
						events: this.events.slice(),
						bridgeTrapHits: this.bridgeTrapHits.slice(),
						sideEffectHits: this.sideEffectHits.slice(),
						detachedClicks: this.detachedClicks,
						closedShadowClicks: this.closedShadowClicks,
						counter: this.counter,
						iframes: { ...this.iframes },
						closedShadowMode: this.closedShadowMode,
						openShadowButtonId: this.openShadowButtonId,
						closedShadowButtonId: this.closedShadowButtonId,
					};
				},
				resetRuntimeState() {
					this.clicks.length = 0;
					this.events.length = 0;
					this.bridgeTrapHits.length = 0;
					this.sideEffectHits.length = 0;
					this.detachedClicks = 0;
					this.closedShadowClicks = 0;
					this.counter = 0;
					return true;
				},
				installBridgeTraps() {
					if (this._bridgeTrapRestore) {
						this.bridgeTrapHits.length = 0;
						return {
							patched: this._bridgeTrapPatched.slice(),
							alreadyInstalled: true,
						};
					}
					this.bridgeTrapHits.length = 0;
					const restore = [];
					const patched = [];
					const hits = this.bridgeTrapHits;
					const patchValue = (owner, key, label, factory) => {
						const descriptor = Object.getOwnPropertyDescriptor(owner, key);
						const original = owner[key];
						try {
							Object.defineProperty(owner, key, {
								configurable: true,
								writable: true,
								value: factory(original),
							});
							restore.push(() => {
								if (descriptor) {
									Object.defineProperty(owner, key, descriptor);
								} else {
									owner[key] = original;
								}
							});
							patched.push(label);
						} catch (error) {
							hits.push({
								kind: "patch-failed",
								label,
								message: String(error?.message || error),
							});
						}
					};
					patchValue(window, "postMessage", "window.postMessage", () => {
						return function (...args) {
							hits.push({
								kind: "window.postMessage",
								argCount: args.length,
							});
							throw new Error("window.postMessage bridge call detected");
						};
					});
					if (typeof window.MessageChannel === "function") {
						patchValue(window, "MessageChannel", "window.MessageChannel", (Original) => {
							return function (...args) {
								hits.push({
									kind: "window.MessageChannel",
									argCount: args.length,
								});
								return Reflect.construct(Original, args, new.target || Original);
							};
						});
					}
					if (typeof window.CustomEvent === "function") {
						patchValue(window, "CustomEvent", "window.CustomEvent", (Original) => {
							return function (...args) {
								hits.push({
									kind: "window.CustomEvent",
									type: args[0] ?? null,
								});
								return Reflect.construct(Original, args, new.target || Original);
							};
						});
					}
					if (typeof window.MutationObserver === "function") {
						patchValue(
							window,
							"MutationObserver",
							"window.MutationObserver",
							(Original) => {
								return function (...args) {
									hits.push({ kind: "window.MutationObserver" });
									return Reflect.construct(Original, args, new.target || Original);
								};
							},
						);
					}
					patchValue(window, "dispatchEvent", "window.dispatchEvent", (original) => {
						return function (event) {
							hits.push({
								kind: "window.dispatchEvent",
								type: event?.type ?? null,
							});
							return original.call(this, event);
						};
					});
					patchValue(
						document,
						"dispatchEvent",
						"document.dispatchEvent",
						(original) => {
							return function (event) {
								hits.push({
									kind: "document.dispatchEvent",
									type: event?.type ?? null,
								});
								return original.call(this, event);
							};
						},
					);
					this._bridgeTrapPatched = patched;
					this._bridgeTrapRestore = () => {
						while (restore.length) {
							restore.pop()();
						}
						this._bridgeTrapPatched = [];
						this._bridgeTrapRestore = null;
					};
					return {
						patched: patched.slice(),
						alreadyInstalled: false,
					};
				},
				restoreBridgeTraps() {
					this._bridgeTrapRestore?.();
					return { patched: [] };
				},
			};
			window[sentinelName] = state;

			const recordClick = (label) => (event) => {
				state.clicks.push({
					label,
					type: event.type,
					targetId: event.currentTarget?.id ?? null,
					isTrusted: event.isTrusted,
				});
			};

			for (const [label, node] of [
				["button", button],
				["hidden", hiddenButton],
				["displayNone", displayNoneButton],
				["pointerNone", pointerNoneButton],
				["disabled", disabledButton],
				["shadowOpen", openShadowButton],
				["shadowClosed", closedShadowButton],
			]) {
				node.addEventListener("click", recordClick(label));
			}

			closedShadowButton.addEventListener("click", () => {
				state.closedShadowClicks += 1;
			});

			const detachedButton = document.createElement("button");
			detachedButton.id = `${fixtureId}-detached-button`;
			detachedButton.addEventListener("click", () => {
				state.detachedClicks += 1;
			});

			const recordEvent = (event) => {
				const entry = {
					type: event.type,
					constructorName: event.constructor?.name || "",
					targetId: event.currentTarget?.id ?? null,
					bubbles: Boolean(event.bubbles),
					cancelable: Boolean(event.cancelable),
					composed: Boolean(event.composed),
					defaultPrevented: Boolean(event.defaultPrevented),
				};
				for (const numericKey of [
					"button",
					"buttons",
					"clientX",
					"clientY",
					"location",
					"deltaX",
					"deltaY",
					"deltaZ",
					"deltaMode",
					"pointerId",
					"elapsedTime",
				]) {
					if (typeof event[numericKey] === "number") {
						entry[numericKey] = event[numericKey];
					}
				}
				for (const stringKey of [
					"key",
					"code",
					"data",
					"inputType",
					"pointerType",
					"propertyName",
					"animationName",
					"pseudoElement",
					"oldURL",
					"newURL",
					"oldValue",
					"newValue",
				]) {
					if (typeof event[stringKey] === "string") {
						entry[stringKey] = event[stringKey];
					}
				}
				for (const booleanKey of [
					"repeat",
					"shiftKey",
					"ctrlKey",
					"altKey",
					"metaKey",
					"isComposing",
					"isPrimary",
					"persisted",
				]) {
					if (typeof event[booleanKey] === "boolean") {
						entry[booleanKey] = event[booleanKey];
					}
				}
				if (event instanceof CustomEvent) entry.detail = event.detail;
				if ("state" in event && event.state !== undefined) {
					entry.state = event.state;
				}
				if ("submitter" in event) {
					entry.submitterId = event.submitter?.id ?? null;
				}
				if ("relatedTarget" in event) {
					entry.relatedTargetId = event.relatedTarget?.id ?? null;
				}
				if ("clipboardData" in event) {
					entry.hasClipboardData = Boolean(event.clipboardData);
				}
				if ("dataTransfer" in event) {
					entry.hasDataTransfer = Boolean(event.dataTransfer);
				}
				if (event instanceof StorageEvent) {
					entry.storageKey = event.key;
				}
				state.events.push(entry);
			};

			for (const type of eventTypes) {
				eventTarget.addEventListener(type, recordEvent);
				form.addEventListener(type, recordEvent);
				details.addEventListener(type, recordEvent);
			}
			eventTarget.addEventListener("us-cancelled-event", (event) => {
				event.preventDefault();
			});

			try {
				void sandboxFrame.contentDocument?.body;
			} catch {
				state.iframes.sandboxOpaque = true;
			}
			try {
				void dataFrame.contentDocument?.body;
			} catch {
				state.iframes.dataOpaque = true;
			}

			return {
				fixtureCreated: Boolean(document.getElementById(fixtureId)),
				sentinelRealm: state.realm,
				windowIsGlobalThis: window === globalThis,
				documentType: document.constructor.name,
				weirdId,
				iframes: { ...state.iframes },
				openShadowButtonId: state.openShadowButtonId,
				closedShadowButtonId: state.closedShadowButtonId,
			};
		}, FIXTURE_ID, SENTINEL);
	}

	async function cleanupMainWorldFixture() {
		return gmGetPageData((fixtureId, sentinelName) => {
			try {
				window[sentinelName]?.restoreBridgeTraps?.();
			} catch {
				// ignore cleanup errors
			}
			document.getElementById(fixtureId)?.remove();
			delete window[sentinelName];
			return {
				fixturePresent: Boolean(document.getElementById(fixtureId)),
				sentinelPresent: Object.prototype.hasOwnProperty.call(
					window,
					sentinelName,
				),
			};
		}, FIXTURE_ID, SENTINEL);
	}

	function registerPrimitiveCases() {
		const cases = [
			{
				name: "null",
				run: () => gmGetPageData(() => null),
				expected: null,
			},
			{
				name: "boolean true",
				run: () => gmGetPageData(() => true),
				expected: true,
			},
			{
				name: "boolean false",
				run: () => gmGetPageData(() => false),
				expected: false,
			},
			{
				name: "zero",
				run: () => gmGetPageData(() => 0),
				expected: 0,
			},
			{
				name: "negative zero",
				run: () => gmGetPageData(() => -0),
				expected: -0,
			},
			{
				name: "integer",
				run: () => gmGetPageData(() => 42),
				expected: 42,
			},
			{
				name: "float",
				run: () => gmGetPageData(() => 123.5),
				expected: 123.5,
			},
			{
				name: "empty string",
				run: () => gmGetPageData(() => ""),
				expected: "",
			},
			{
				name: "unicode string",
				run: () => gmGetPageData(() => "Привет MAIN world ✓"),
				expected: "Привет MAIN world ✓",
			},
			{
				name: "nested arrays",
				run: () =>
					gmGetPageData(() => [1, "two", false, null, [3, 4, { five: 5 }]]),
				expected: [1, "two", false, null, [3, 4, { five: 5 }]],
			},
			{
				name: "nested plain objects",
				run: () =>
					gmGetPageData(() => ({
						alpha: 1,
						beta: { gamma: 2, delta: [3, 4, 5] },
					})),
				expected: {
					alpha: 1,
					beta: { gamma: 2, delta: [3, 4, 5] },
				},
			},
			{
				name: "duplicate plain references become stable clones",
				run: () =>
					gmGetPageData(() => {
						const child = { value: 7 };
						return {
							left: child,
							right: child,
						};
					}),
				expected: {
					left: { value: 7 },
					right: { value: 7 },
				},
			},
			{
				name: "serializable arguments",
				run: () =>
					gmGetPageData(
						(a, b, c) => ({
							sum: a + b,
							copy: c,
							isArray: Array.isArray(c.items),
						}),
						7,
						8,
						{ items: ["x", "y"] },
					),
				expected: {
					sum: 15,
					copy: { items: ["x", "y"] },
					isArray: true,
				},
			},
			{
				name: "async extractor",
				run: () =>
					gmGetPageData(async () => {
						await Promise.resolve();
						return { async: true, title: document.title };
					}),
				expected: null,
				verify(value) {
					ok(value.async === true, "expected async flag");
					ok(typeof value.title === "string", "expected title string");
				},
			},
			{
				name: "page DOM access",
				run: () =>
					gmGetPageData((fixtureId) => {
						const node = document.getElementById(`${fixtureId}-text`);
						return {
							found: Boolean(node),
							text: node?.textContent ?? null,
							ownerDocumentMatches: node?.ownerDocument === document,
						};
					}, FIXTURE_ID),
				expected: {
					found: true,
					text: "MAIN world text ✓",
					ownerDocumentMatches: true,
				},
			},
			{
				name: "MAIN-world state access",
				run: () =>
					gmGetPageData((sentinelName) => {
						return window[sentinelName].snapshot();
					}, SENTINEL),
				expected: null,
				verify(value) {
					ok(value.realm === "MAIN", "unexpected realm");
					ok(Array.isArray(value.events), "events should be array");
				},
			},
			{
				name: "frozen plain object",
				run: () =>
					gmGetPageData(() => {
						return Object.freeze({ stable: true, nested: { count: 2 } });
					}),
				expected: { stable: true, nested: { count: 2 } },
			},
			{
				name: "sealed plain object",
				run: () =>
					gmGetPageData(() => {
						return Object.seal({ stable: true, nested: { count: 3 } });
					}),
				expected: { stable: true, nested: { count: 3 } },
			},
			{
				name: "deep plain object",
				run: () =>
					gmGetPageData(() => {
						let cursor = { leaf: "done" };
						for (let depth = 0; depth < 24; depth += 1) {
							cursor = { depth, child: cursor };
						}
						return cursor;
					}),
				expected: null,
				verify(value) {
					let cursor = value;
					for (let depth = 23; depth >= 0; depth -= 1) {
						equal(cursor.depth, depth, `unexpected depth at ${depth}`);
						cursor = cursor.child;
					}
					equal(cursor, { leaf: "done" });
				},
			},
			{
				name: "large plain object",
				run: () =>
					gmGetPageData(() => {
						const value = {};
						for (let index = 0; index < 120; index += 1) {
							value[`key_${index}`] = {
								index,
								parity: index % 2 === 0,
							};
						}
						return value;
					}),
				expected: null,
				verify(value) {
					equal(Object.keys(value).length, 120);
					equal(value.key_0, { index: 0, parity: true });
					equal(value.key_119, { index: 119, parity: false });
				},
			},
			{
				name: "large plain array",
				run: () =>
					gmGetPageData(() => {
						return Array.from({ length: 2000 }, (_item, index) => index);
					}),
				expected: null,
				verify(value) {
					equal(value.length, 2000);
					equal(value[0], 0);
					equal(value[1999], 1999);
				},
			},
		];

		for (const entry of cases) {
			test(`GM.getPageData returns ${entry.name}`, async () => {
				const value = await entry.run();
				if (typeof entry.verify === "function") {
					entry.verify(value);
					return;
				}
				equal(value, entry.expected);
			});
		}
	}

	function registerUnsupportedResultCases() {
		const unsupported = [
			{
				name: "undefined result",
				run: () => gmGetPageData(() => undefined),
				fragments: ["unsupported type", "undefined"],
			},
			{
				name: "NaN result",
				run: () => gmGetPageData(() => Number.NaN),
				fragments: ["non-finite number", "unsupported type"],
			},
			{
				name: "Infinity result",
				run: () => gmGetPageData(() => Number.POSITIVE_INFINITY),
				fragments: ["non-finite number", "unsupported type"],
			},
			{
				name: "-Infinity result",
				run: () => gmGetPageData(() => Number.NEGATIVE_INFINITY),
				fragments: ["non-finite number", "unsupported type"],
			},
			{
				name: "BigInt result",
				run: () => gmGetPageData(() => 1n),
				fragments: ["unsupported type", "bigint"],
			},
			{
				name: "Symbol result",
				run: () => gmGetPageData(() => Symbol("page-symbol")),
				fragments: ["unsupported type", "symbol"],
			},
			{
				name: "Date result",
				run: () => gmGetPageData(() => new Date("2024-01-02T03:04:05.000Z")),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "RegExp result",
				run: () => gmGetPageData(() => /page-regression/gi),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "URL result",
				run: () => gmGetPageData(() => new URL(location.href)),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "URLSearchParams result",
				run: () => gmGetPageData(() => new URLSearchParams("a=1&b=2")),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "Error result",
				run: () => gmGetPageData(() => new Error("page error object")),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "Map result",
				run: () => gmGetPageData(() => new Map([["alpha", 1]])),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "Set result",
				run: () => gmGetPageData(() => new Set([1, 2, 3])),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "WeakMap result",
				run: () => gmGetPageData(() => new WeakMap([[{}, 1]])),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "WeakSet result",
				run: () => gmGetPageData(() => new WeakSet([{}])),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "ArrayBuffer result",
				run: () => gmGetPageData(() => new ArrayBuffer(16)),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "DataView result",
				run: () => gmGetPageData(() => new DataView(new ArrayBuffer(16))),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "Blob result",
				run: () =>
					gmGetPageData(() => new Blob(["blob payload"], { type: "text/plain" })),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "File result",
				run: () =>
					gmGetPageData(
						() => new File(["abc"], "fixture.txt", { type: "text/plain" }),
					),
				fragments: ["object must be plain", "unsupported type"],
				optional: true,
				precheck: () => pageHasConstructor("File"),
			},
			{
				name: "FileList result",
				run: () =>
					gmGetPageData((fixtureId) => {
						return document.getElementById(`${fixtureId}-file-input`).files;
					}, FIXTURE_ID),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "HTMLElement result",
				run: () => gmGetPageData(() => document.documentElement),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "Text node result",
				run: () => gmGetPageData(() => document.createTextNode("text node")),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "Comment node result",
				run: () => gmGetPageData(() => document.createComment("comment node")),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "Document result",
				run: () => gmGetPageData(() => document),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "Window result",
				run: () => gmGetPageData(() => window),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "ShadowRoot result",
				run: () =>
					gmGetPageData((fixtureId) => {
						return document
							.getElementById(`${fixtureId}-shadow-host-open`)
							.shadowRoot;
					}, FIXTURE_ID),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "MutationObserver result",
				run: () =>
					gmGetPageData(() => new MutationObserver(() => {})),
				fragments: ["object must be plain", "unsupported type"],
				precheck: () => pageHasConstructor("MutationObserver"),
			},
			{
				name: "AbortController result",
				run: () => gmGetPageData(() => new AbortController()),
				fragments: ["object must be plain", "unsupported type"],
				optional: true,
				precheck: () => pageHasConstructor("AbortController"),
			},
			{
				name: "AbortSignal result",
				run: () => gmGetPageData(() => new AbortController().signal),
				fragments: ["object must be plain", "unsupported type"],
				optional: true,
				precheck: () => pageHasConstructor("AbortController"),
			},
			{
				name: "Function result",
				run: () => gmGetPageData(() => function pageFn() {}),
				fragments: ["unsupported type", "function"],
			},
			{
				name: "class instance result",
				run: () =>
					gmGetPageData(() => {
						class Box {
							constructor(value) {
								this.value = value;
							}
						}
						return new Box(4);
					}),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "generator result",
				run: () =>
					gmGetPageData(() => {
						return (function* pageGenerator() {
							yield 1;
						})();
					}),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "async generator result",
				run: () =>
					gmGetPageData(() => {
						return (async function* pageAsyncGenerator() {
							yield 1;
						})();
					}),
				fragments: ["object must be plain", "unsupported type"],
			},
			{
				name: "Promise result without awaiting",
				run: () => gmGetPageData(() => Promise.resolve({ shouldNotLeak: true })),
				fragments: ["unsupported type", "object must be plain", "promise"],
				optional: true,
			},
			{
				name: "cyclic object result",
				run: () =>
					gmGetPageData(() => {
						const value = {};
						value.self = value;
						return value;
					}),
				fragments: ["cycle", "circular"],
			},
			{
				name: "unsafe __proto__ key",
				run: () =>
					gmGetPageData(() => {
						const value = Object.create(null);
						Object.defineProperty(value, "__proto__", {
							value: "blocked",
							enumerable: true,
						});
						return value;
					}),
				fragments: ["object key is not allowed", "__proto__"],
			},
			{
				name: "unsafe constructor key",
				run: () =>
					gmGetPageData(() => ({
						constructor: "blocked",
					})),
				fragments: ["object key is not allowed", "constructor"],
			},
			{
				name: "unsafe prototype key",
				run: () =>
					gmGetPageData(() => ({
						prototype: "blocked",
					})),
				fragments: ["object key is not allowed", "prototype"],
			},
			{
				name: "unsupported argument type",
				run: () => gmGetPageData((value) => value, () => {}),
				fragments: ["value type is not supported", "unsupported type"],
			},
			{
				name: "unsafe argument key",
				run: () =>
					gmGetPageData(
						(value) => value,
						JSON.parse('{"safe":1,"__proto__":{"polluted":true}}'),
					),
				fragments: ["object key is not allowed", "__proto__"],
			},
		];

		const typedArrays = [
			"Int8Array",
			"Uint8Array",
			"Uint8ClampedArray",
			"Int16Array",
			"Uint16Array",
			"Int32Array",
			"Uint32Array",
			"Float32Array",
			"Float64Array",
			"BigInt64Array",
			"BigUint64Array",
		];

		for (const ctorName of typedArrays) {
			unsupported.push({
				name: `${ctorName} result`,
				run: () => gmGetPageData((name) => new window[name](4), ctorName),
				fragments: ["object must be plain", "unsupported type"],
				optional: ctorName.startsWith("Big"),
				precheck: () => pageHasConstructor(ctorName),
			});
		}

		for (const ctorName of ["AggregateError", "ImageData", "DOMRect", "DOMPoint", "DOMMatrix"]) {
			unsupported.push({
				name: `${ctorName} result`,
				run: () =>
					gmGetPageData((name) => {
						switch (name) {
							case "AggregateError":
								return new AggregateError([new Error("a")], "aggregate");
							case "ImageData":
								return new ImageData(1, 1);
							case "DOMRect":
								return new DOMRect(1, 2, 3, 4);
							case "DOMPoint":
								return new DOMPoint(1, 2, 3, 4);
							case "DOMMatrix":
								return new DOMMatrix([1, 0, 0, 1, 5, 6]);
							default:
								return null;
						}
					}, ctorName),
				fragments: ["object must be plain", "unsupported type"],
				optional: true,
				precheck: () => pageHasConstructor(ctorName),
			});
		}

		for (const entry of unsupported) {
			test(`GM.getPageData rejects ${entry.name}`, async () => {
				if (entry.precheck && !(await entry.precheck())) {
					skip(`${entry.name} is unavailable in this browser`);
				}
				await rejects(entry.run, entry.fragments);
			}, { optional: entry.optional });
		}
	}

	function registerPageCallCases() {
		test("GM.page.call dom.exists returns target presence", async () => {
			equal(
				await gmPageCall("dom.exists", selectorFor(`${FIXTURE_ID}-html`)),
				true,
			);
			equal(
				await gmPageCall("dom.exists", selectorFor(`${FIXTURE_ID}-missing`)),
				false,
			);
		});

		test("GM.page.call dom.count counts matching nodes", async () => {
			equal(await gmPageCall("dom.count", `.${FIXTURE_ID}-item`), 2);
		});

		test("GM.page.call dom.queryText returns text", async () => {
			equal(
				await gmPageCall("dom.queryText", selectorFor(`${FIXTURE_ID}-text`)),
				"MAIN world text ✓",
			);
		});

		test("GM.page.call dom.queryText returns null for missing target", async () => {
			equal(
				await gmPageCall("dom.queryText", selectorFor(`${FIXTURE_ID}-missing`)),
				null,
			);
		});

		test("GM.page.call dom.queryText supports escaped selectors", async () => {
			const meta = await localFixtureMeta();
			equal(
				await gmPageCall("dom.queryText", selectorFor(meta.weirdId)),
				"Escaped selector text",
			);
		});

		test("GM.page.call dom.queryText reads SVG text", async () => {
			equal(
				await gmPageCall("dom.queryText", selectorFor(`${FIXTURE_ID}-svg-text`)),
				"SVG text",
			);
		});

		test("GM.page.call dom.queryText reads MathML text", async () => {
			equal(
				await gmPageCall("dom.queryText", selectorFor(`${FIXTURE_ID}-math-text`)),
				"MathML text",
			);
		}, { optional: true });

		test("GM.page.call dom.queryText does not pierce open shadow DOM", async () => {
			equal(
				await gmPageCall(
					"dom.queryText",
					selectorFor(`${FIXTURE_ID}-shadow-open-text`),
				),
				null,
			);
		});

		test("GM.page.call dom.queryText does not pierce closed shadow DOM", async () => {
			equal(
				await gmPageCall(
					"dom.queryText",
					selectorFor(`${FIXTURE_ID}-shadow-closed-text`),
				),
				null,
			);
		});

		test("GM.page.call dom.queryHtml returns inner HTML", async () => {
			const html = await gmPageCall("dom.queryHtml", selectorFor(`${FIXTURE_ID}-html`));
			includes(html, ["Alpha", "Beta", "data-kind"]);
		});

		test("GM.page.call dom.queryOuterHtml returns outer HTML", async () => {
			const html = await gmPageCall(
				"dom.queryOuterHtml",
				selectorFor(`${FIXTURE_ID}-html`),
			);
			includes(html, [`id="${FIXTURE_ID}-html"`, "data-state"]);
		});

		test("GM.page.call dom.queryAttr returns attributes", async () => {
			equal(
				await gmPageCall(
					"dom.queryAttr",
					selectorFor(`${FIXTURE_ID}-html`),
					"data-state",
				),
				"ready",
			);
			equal(
				await gmPageCall(
					"dom.queryAttr",
					selectorFor(`${FIXTURE_ID}-html`),
					"data-missing",
				),
				null,
			);
		});

		test("GM.page.call dom.queryProperty returns allowlisted properties", async () => {
			equal(
				await gmPageCall(
					"dom.queryProperty",
					selectorFor(`${FIXTURE_ID}-input`),
					"placeholder",
				),
				"fixture placeholder",
			);
			equal(
				await gmPageCall(
					"dom.queryProperty",
					selectorFor(`${FIXTURE_ID}-html`),
					"className",
				),
				`${FIXTURE_ID}-class alpha beta`,
			);
		});

		test("GM.page.call dom.queryRect returns a rect-like object", async () => {
			const rect = await gmPageCall("dom.queryRect", selectorFor(`${FIXTURE_ID}-html`));
			ok(rect && typeof rect === "object", "expected rect object");
			for (const key of [
				"x",
				"y",
				"width",
				"height",
				"top",
				"right",
				"bottom",
				"left",
			]) {
				ok(Number.isFinite(rect[key]), `rect.${key} should be finite`);
			}
		});

		test("GM.page.call dom.queryClassList returns class tokens", async () => {
			equal(
				await gmPageCall("dom.queryClassList", selectorFor(`${FIXTURE_ID}-html`)),
				[`${FIXTURE_ID}-class`, "alpha", "beta"],
			);
		});

		test("GM.page.call dom.queryAllText returns all matching text", async () => {
			equal(await gmPageCall("dom.queryAllText", `.${FIXTURE_ID}-item`), [
				"Item Alpha",
				"Item Beta",
			]);
		});

		test("GM.page.call dom.queryAllAttr returns all matching attributes", async () => {
			equal(
				await gmPageCall("dom.queryAllAttr", `.${FIXTURE_ID}-item`, "data-rank"),
				["1", "2"],
			);
		});

		test("GM.page.call dom.queryAllProperty returns all matching properties", async () => {
			equal(
				await gmPageCall("dom.queryAllProperty", `.${FIXTURE_ID}-item`, "title"),
				["Item title alpha", "Item title beta"],
			);
		});

		test("GM.page.call dom.queryText rejects blank selector", async () => {
			await rejects(
				() => gmPageCall("dom.queryText", "   "),
				["selector must be a non-empty string", "selector"],
			);
		});

		test("GM.page.call dom.queryText rejects invalid selector", async () => {
			await rejects(
				() => gmPageCall("dom.queryText", "div["),
				["selector", "Failed to execute"],
			);
		});

		for (const [label, badSelector] of [
			["null selector", null],
			["undefined selector", undefined],
			["numeric selector", 5],
			["object selector", { selector: "#x" }],
		]) {
			test(`GM.page.call dom.queryText rejects ${label}`, async () => {
				await rejects(
					() => gmPageCall("dom.queryText", badSelector),
					["selector must be a non-empty string", "selector"],
				);
			});
		}

		test("GM.page.call dom.queryText rejects extra arguments", async () => {
			await rejects(
				() => gmPageCall("dom.queryText", selectorFor(`${FIXTURE_ID}-text`), "extra"),
				["expects exactly 1 argument", "exactly 1 argument"],
			);
		});

		test("GM.page.call dom.click runs page-world click handler", async () => {
			await resetLocalFixtureState();
			equal(
				await gmPageCall("dom.click", selectorFor(`${FIXTURE_ID}-button`)),
				true,
			);
			equal(await lastLocalClick(), {
				label: "button",
				type: "click",
				targetId: `${FIXTURE_ID}-button`,
				isTrusted: false,
			});
		});

		test("GM.page.call dom.click returns false for missing target", async () => {
			equal(
				await gmPageCall("dom.click", selectorFor(`${FIXTURE_ID}-missing`)),
				false,
			);
		});

		for (const [label, id] of [
			["hidden element", `${FIXTURE_ID}-button-hidden`],
			["display:none element", `${FIXTURE_ID}-button-display-none`],
			["pointer-events:none element", `${FIXTURE_ID}-button-pointer-none`],
		]) {
			test(`GM.page.call dom.click triggers ${label}`, async () => {
				await resetLocalFixtureState();
				equal(await gmPageCall("dom.click", selectorFor(id)), true);
				const click = await lastLocalClick();
				ok(click?.targetId === id, `unexpected click target for ${label}`);
			});
		}

		test("GM.page.call dom.click on disabled button does not emit click", async () => {
			await resetLocalFixtureState();
			await gmPageCall("dom.click", selectorFor(`${FIXTURE_ID}-button-disabled`));
			equal(await localClickLog(), []);
		}, { optional: true });

		test("GM.page.call dom.click does not pierce open shadow DOM", async () => {
			await resetLocalFixtureState();
			equal(
				await gmPageCall(
					"dom.click",
					selectorFor(`${FIXTURE_ID}-shadow-open-button`),
				),
				false,
			);
			equal(await localClickLog(), []);
		});

		test("GM.page.call dom.click does not pierce closed shadow DOM", async () => {
			await resetLocalFixtureState();
			equal(
				await gmPageCall(
					"dom.click",
					selectorFor(`${FIXTURE_ID}-shadow-closed-button`),
				),
				false,
			);
			equal(await localClickLog(), []);
		});

		test("GM.page.call dom.focus and dom.blur update activeElement", async () => {
			const input = document.getElementById(`${FIXTURE_ID}-input`);
			input.blur();
			equal(await gmPageCall("dom.focus", selectorFor(`${FIXTURE_ID}-input`)), true);
			equal(document.activeElement, input);
			equal(await gmPageCall("dom.blur", selectorFor(`${FIXTURE_ID}-input`)), true);
			ok(document.activeElement !== input, "input should no longer be active");
		});

		test("GM.page.call dom.setValue updates input value", async () => {
			const input = document.getElementById(`${FIXTURE_ID}-input`);
			input.value = "fixture input";
			equal(
				await gmPageCall("dom.setValue", selectorFor(`${FIXTURE_ID}-input`), "updated"),
				true,
			);
			equal(input.value, "updated");
		});

		test("GM.page.call dom.setChecked updates checkbox state", async () => {
			const checkbox = document.getElementById(`${FIXTURE_ID}-checkbox`);
			checkbox.checked = false;
			equal(
				await gmPageCall(
					"dom.setChecked",
					selectorFor(`${FIXTURE_ID}-checkbox`),
					true,
				),
				true,
			);
			equal(checkbox.checked, true);
		});

		test("GM.page.call dom.setSelectedIndex updates select state", async () => {
			const select = document.getElementById(`${FIXTURE_ID}-select`);
			select.selectedIndex = 0;
			equal(
				await gmPageCall(
					"dom.setSelectedIndex",
					selectorFor(`${FIXTURE_ID}-select`),
					2,
				),
				true,
			);
			equal(select.selectedIndex, 2);
		});

		test("GM.page.call page getters return page state", async () => {
			equal(await gmPageCall("page.getTitle"), document.title);
			const locationSnapshot = await gmPageCall("page.getLocation");
			equal(locationSnapshot.pathname, location.pathname);
			equal(locationSnapshot.search, location.search);
			equal(locationSnapshot.hash, location.hash);
			ok(
				["loading", "interactive", "complete"].includes(
					await gmPageCall("page.getReadyState"),
				),
				"unexpected document.readyState",
			);
			const visibility = await gmPageCall("page.getVisibility");
			equal(visibility.hidden, document.hidden);
			equal(visibility.visibilityState, document.visibilityState);
			const selection = globalThis.getSelection?.();
			const textNode = document.getElementById(`${FIXTURE_ID}-text`);
			if (!selection || !textNode) {
				skip("Selection API is unavailable in this browser");
			}
			const range = document.createRange();
			range.selectNodeContents(textNode);
			selection.removeAllRanges();
			selection.addRange(range);
			try {
				equal(await gmPageCall("page.getSelectionText"), "MAIN world text ✓");
			} finally {
				selection.removeAllRanges();
			}
		});

		test("GM.page.call page.snapshot batches supported operations", async () => {
			const input = document.getElementById(`${FIXTURE_ID}-input`);
			input.value = "snapshot value";
			const selection = globalThis.getSelection?.();
			const textNode = document.getElementById(`${FIXTURE_ID}-text`);
			if (!selection || !textNode) {
				skip("Selection API is unavailable in this browser");
			}
			const range = document.createRange();
			range.selectNodeContents(textNode);
			selection.removeAllRanges();
			selection.addRange(range);
			try {
				const snapshot = await gmPageCall("page.snapshot", {
					title: true,
					location: ["pathname", "search", "hash"],
					readyState: true,
					visibility: true,
					selectionText: true,
					queries: {
						exists: {
							kind: "exists",
							selector: selectorFor(`${FIXTURE_ID}-html`),
						},
						text: {
							kind: "text",
							selector: selectorFor(`${FIXTURE_ID}-text`),
						},
						html: {
							kind: "html",
							selector: selectorFor(`${FIXTURE_ID}-html`),
						},
						outerHtml: {
							kind: "outerHtml",
							selector: selectorFor(`${FIXTURE_ID}-html`),
						},
						attr: {
							kind: "attr",
							selector: selectorFor(`${FIXTURE_ID}-html`),
							attribute: "data-state",
						},
						property: {
							kind: "property",
							selector: selectorFor(`${FIXTURE_ID}-input`),
							property: "value",
						},
						rect: {
							kind: "rect",
							selector: selectorFor(`${FIXTURE_ID}-html`),
						},
						classList: {
							kind: "classList",
							selector: selectorFor(`${FIXTURE_ID}-html`),
						},
						allText: {
							kind: "allText",
							selector: `.${FIXTURE_ID}-item`,
						},
						allAttr: {
							kind: "allAttr",
							selector: `.${FIXTURE_ID}-item`,
							attribute: "data-rank",
						},
						allProperty: {
							kind: "allProperty",
							selector: `.${FIXTURE_ID}-item`,
							property: "title",
						},
						count: {
							kind: "count",
							selector: `.${FIXTURE_ID}-item`,
						},
					},
				});
				equal(snapshot.title, document.title);
				equal(snapshot.location.pathname, location.pathname);
				equal(snapshot.location.search, location.search);
				equal(snapshot.location.hash, location.hash);
				equal(snapshot.selectionText, "MAIN world text ✓");
				equal(snapshot.queries.exists, true);
				equal(snapshot.queries.text, "MAIN world text ✓");
				includes(snapshot.queries.html, ["Alpha", "Beta"]);
				includes(snapshot.queries.outerHtml, [`id="${FIXTURE_ID}-html"`]);
				equal(snapshot.queries.attr, "ready");
				equal(snapshot.queries.property, "snapshot value");
				equal(snapshot.queries.classList, [`${FIXTURE_ID}-class`, "alpha", "beta"]);
				equal(snapshot.queries.allText, ["Item Alpha", "Item Beta"]);
				equal(snapshot.queries.allAttr, ["1", "2"]);
				equal(snapshot.queries.allProperty, [
					"Item title alpha",
					"Item title beta",
				]);
				equal(snapshot.queries.count, 2);
				ok(snapshot.queries.rect && typeof snapshot.queries.rect === "object");
			} finally {
				selection.removeAllRanges();
			}
		});

		test("GM.page.call dom.click rejects blank selector", async () => {
			await rejects(
				() => gmPageCall("dom.click", ""),
				["selector must be a non-empty string", "selector"],
			);
		});

		test("GM.page.call dom.click rejects invalid selector", async () => {
			await rejects(
				() => gmPageCall("dom.click", "button["),
				["selector", "Failed to execute"],
			);
		});

		for (const [label, badSelector] of [
			["null selector", null],
			["undefined selector", undefined],
			["numeric selector", 5],
			["object selector", { selector: "#x" }],
		]) {
			test(`GM.page.call dom.click rejects ${label}`, async () => {
				await rejects(
					() => gmPageCall("dom.click", badSelector),
					["selector must be a non-empty string", "selector"],
				);
			});
		}

		test("GM.page.call rejects empty operation", async () => {
			await rejects(
				() => gmPageCall(""),
				["operation must be a non-empty string", "non-empty string"],
			);
		});

		test("GM.page.call rejects unsupported operation", async () => {
			await rejects(
				() => gmPageCall("dom.executeArbitraryCode", "x"),
				["Unsupported page operation", "unsupported"],
			);
		});

		test("GM.page.call enforces argument count", async () => {
			await rejects(
				() => gmPageCall("dom.queryText"),
				["expects exactly 1 argument", "exactly 1 argument"],
			);
			await rejects(
				() => gmPageCall("event.dispatch", selectorFor(`${FIXTURE_ID}-event-target`)),
				["expects exactly 2 arguments", "exactly 2 arguments"],
			);
		});
	}

	function registerEventDispatchCases() {
		test("event.dispatch dispatches base Event", async () => {
			await resetLocalFixtureState();
			equal(
				await gmEventDispatch(selectorFor(`${FIXTURE_ID}-event-target`), {
					kind: "event",
					type: "us-basic-event",
					bubbles: true,
					cancelable: true,
					composed: true,
				}),
				true,
			);
			const event = await lastLocalEvent();
			equal(event.type, "us-basic-event");
			equal(event.constructorName, "Event");
			equal(event.bubbles, true);
			equal(event.cancelable, true);
			equal(event.composed, true);
		}, { optional: true });

		test("event.dispatch dispatches CustomEvent detail", async () => {
			await resetLocalFixtureState();
			await gmEventDispatch(selectorFor(`${FIXTURE_ID}-event-target`), {
				kind: "custom",
				type: "us-custom-event",
				bubbles: true,
				detail: { message: "hello", list: [1, 2, 3] },
			});
			const event = await lastLocalEvent();
			equal(event.constructorName, "CustomEvent");
			equal(event.detail, { message: "hello", list: [1, 2, 3] });
		}, { optional: true });

		test("event.dispatch dispatches MouseEvent fields", async () => {
			await resetLocalFixtureState();
			await gmEventDispatch(selectorFor(`${FIXTURE_ID}-event-target`), {
				kind: "mouse",
				type: "mousedown",
				bubbles: true,
				button: 1,
				buttons: 4,
				clientX: 17,
				clientY: 29,
				ctrlKey: true,
			});
			const event = await lastLocalEvent();
			equal(event.constructorName, "MouseEvent");
			equal(event.button, 1);
			equal(event.buttons, 4);
			equal(event.clientX, 17);
			equal(event.clientY, 29);
			equal(event.ctrlKey, true);
		}, { optional: true });

		test("event.dispatch dispatches KeyboardEvent fields", async () => {
			await resetLocalFixtureState();
			await gmEventDispatch(selectorFor(`${FIXTURE_ID}-event-target`), {
				kind: "keyboard",
				type: "keydown",
				bubbles: true,
				key: "K",
				code: "KeyK",
				location: 1,
				repeat: true,
				shiftKey: true,
			});
			const event = await lastLocalEvent();
			equal(event.constructorName, "KeyboardEvent");
			equal(event.key, "K");
			equal(event.code, "KeyK");
			equal(event.location, 1);
			equal(event.repeat, true);
			equal(event.shiftKey, true);
		}, { optional: true });

		test("event.dispatch dispatches InputEvent fields", async () => {
			await resetLocalFixtureState();
			await gmEventDispatch(selectorFor(`${FIXTURE_ID}-event-target`), {
				kind: "input",
				type: "input",
				bubbles: true,
				data: "x",
				inputType: "insertText",
				isComposing: false,
			});
			const event = await lastLocalEvent();
			ok(
				event.constructorName === "InputEvent" || event.constructorName === "Event",
				`unexpected input event constructor: ${event.constructorName}`,
			);
			if (event.constructorName === "InputEvent") {
				equal(event.data, "x");
				equal(event.inputType, "insertText");
				equal(event.isComposing, false);
			}
		}, { optional: true });

		test("event.dispatch supports beforeinput via InputEvent", async () => {
			await resetLocalFixtureState();
			await gmEventDispatch(selectorFor(`${FIXTURE_ID}-event-target`), {
				kind: "input",
				type: "beforeinput",
				bubbles: true,
				data: "b",
				inputType: "insertText",
				isComposing: false,
			});
			const event = await lastLocalEvent();
			equal(event.type, "beforeinput");
			ok(
				event.constructorName === "InputEvent" || event.constructorName === "Event",
				`unexpected beforeinput constructor: ${event.constructorName}`,
			);
		}, { optional: true });

		test("event.dispatch returns false when preventDefault runs", async () => {
			await resetLocalFixtureState();
			equal(
				await gmEventDispatch(selectorFor(`${FIXTURE_ID}-event-target`), {
					kind: "event",
					type: "us-cancelled-event",
					cancelable: true,
				}),
				false,
			);
			equal((await lastLocalEvent()).defaultPrevented, true);
		}, { optional: true });

		test("event.dispatch returns false for missing target", async () => {
			equal(
				await gmEventDispatch(selectorFor(`${FIXTURE_ID}-missing`), {
					kind: "event",
					type: "us-basic-event",
				}),
				false,
			);
		}, { optional: true });

		test("event.dispatch rejects unsupported event kind", async () => {
			await rejects(
				() =>
					gmPageCall("event.dispatch", selectorFor(`${FIXTURE_ID}-event-target`), {
						kind: "message",
						type: "message",
					}),
				["unsupported event kind", "unsupported"],
			);
		});

		test("event.dispatch rejects unknown event-spec key", async () => {
			await rejects(
				() =>
					gmPageCall("event.dispatch", selectorFor(`${FIXTURE_ID}-event-target`), {
						kind: "event",
						type: "us-basic-event",
						arbitraryCode: "alert(1)",
					}),
				["event spec key is not allowed", "not allowed"],
			);
		});

		test("event.dispatch validates event field types", async () => {
			await rejects(
				() =>
					gmPageCall("event.dispatch", selectorFor(`${FIXTURE_ID}-event-target`), {
						kind: "mouse",
						type: "mousedown",
						clientX: "17",
					}),
				["must be a finite number", "finite number"],
			);
			await rejects(
				() =>
					gmPageCall("event.dispatch", selectorFor(`${FIXTURE_ID}-event-target`), {
						kind: "event",
						type: "us-basic-event",
						bubbles: "yes",
					}),
				["must be a boolean", "boolean"],
			);
		});

		const unsupportedEventKinds = [
			["PointerEvent", "pointer", "pointerdown"],
			["FocusEvent", "focus", "focusin"],
			["WheelEvent", "wheel", "wheel"],
			["ClipboardEvent", "clipboard", "copy"],
			["DragEvent", "drag", "dragstart"],
			["CompositionEvent", "composition", "compositionstart"],
			["SubmitEvent", "submit", "submit"],
			["ToggleEvent", "toggle", "toggle"],
			["TransitionEvent", "transition", "transitionend"],
			["AnimationEvent", "animation", "animationend"],
			["HashChangeEvent", "hashchange", "hashchange"],
			["PopStateEvent", "popstate", "popstate"],
			["StorageEvent", "storage", "storage"],
			["PageTransitionEvent", "pagetransition", "pageshow"],
		];

		for (const [label, kind, type] of unsupportedEventKinds) {
			test(`event.dispatch rejects unsupported ${label}`, async () => {
				await rejects(
					() =>
						gmPageCall("event.dispatch", selectorFor(`${FIXTURE_ID}-event-target`), {
							kind,
							type,
							bubbles: true,
						}),
					["unsupported event kind", kind],
				);
			}, { optional: !CONFIG.strictExtended });
		}
	}

	function registerTransportCases() {
		test("GM.getPageData propagates extractor throw", async () => {
			await rejects(
				() =>
					gmGetPageData(() => {
						throw new Error("intentional extractor failure");
					}),
				["intentional extractor failure"],
			);
		});

		test("GM.getPageData propagates async rejection", async () => {
			await rejects(
				() =>
					gmGetPageData(async () => {
						throw new Error("intentional async failure");
					}),
				["intentional async failure"],
			);
		});

		test("GM.getPageData rejects missing/non-function extractor", async () => {
			await rejects(
				() => gmGetPageData("not a function"),
				["getPageData requires a function extractor", "requires a function"],
			);
		});

		test("transport surfaces stack text for page exceptions", async () => {
			const error = await rejects(
				() =>
					gmGetPageData(() => {
						function pageStackMarker() {
							throw new Error("page stack marker");
						}
						pageStackMarker();
					}),
				["page stack marker"],
			);
			ok(
				/String|Error/.test(String(error?.stack || error?.message || error)),
				"missing stack-like text on propagated error",
			);
		});

		test("MAIN transport uses page global scope", async () => {
			const value = await gmGetPageData((sentinelName) => {
				return {
					windowIsGlobalThis: window === globalThis,
					sentinelRealm: window[sentinelName]?.realm ?? null,
					documentType: document.constructor.name,
				};
			}, SENTINEL);
			equal(value, {
				windowIsGlobalThis: true,
				sentinelRealm: "MAIN",
				documentType: "HTMLDocument",
			});
		});

		test("MAIN transport sees same-origin about:blank iframe", async () => {
			const meta = await fixtureMeta();
			ok(meta.iframes.aboutBlankAccessible, "about:blank iframe was not accessible");
			const value = await gmGetPageData((frameId) => {
				return document
					.getElementById(frameId)
					.contentDocument.getElementById("frame-about-text").textContent;
			}, meta.iframes.aboutBlankId);
			equal(value, "about:blank frame text");
		});

		test("MAIN transport sees same-origin srcdoc iframe", async () => {
			const meta = await fixtureMeta();
			ok(meta.iframes.srcdocAccessible, "srcdoc iframe was not accessible");
			const value = await gmGetPageData((frameId) => {
				return document
					.getElementById(frameId)
					.contentDocument.getElementById("frame-srcdoc-text").textContent;
			}, meta.iframes.srcdocId);
			equal(value, "srcdoc frame text");
		});

		test("sandbox iframe remains opaque", async () => {
			const meta = await fixtureMeta();
			ok(meta.iframes.sandboxOpaque, "sandbox iframe was unexpectedly accessible");
		}, { optional: true });

		test("data URL iframe remains opaque", async () => {
			const meta = await fixtureMeta();
			ok(meta.iframes.dataOpaque, "data iframe was unexpectedly accessible");
		}, { optional: true });

		test("transport fails closed for Symbol values", async () => {
			await rejects(
				() => gmGetPageData(() => Symbol("not cloneable")),
				["unsupported type", "symbol"],
			);
		});

		test("transport avoids bridge primitives during GM.getPageData", async () => {
			await withTransportTrapAssertions("GM.getPageData", async () => {
				equal(await gmGetPageData(() => 123), 123);
			});
		});

		test("transport avoids bridge primitives during GM.page.call dom.queryText", async () => {
			await withTransportTrapAssertions("GM.page.call dom.queryText", async () => {
				equal(
					await gmPageCall("dom.queryText", selectorFor(`${FIXTURE_ID}-text`)),
					"MAIN world text ✓",
				);
			});
		});

		test("transport survives page monkey-patching while staying in MAIN world", async () => {
			await withTransportTrapAssertions("MAIN world monkey-patching", async () => {
				const marker = await gmGetPageData((sentinelName) => {
					const original = window[sentinelName].counter;
					window[sentinelName].counter = original + 1;
					return {
						counter: window[sentinelName].counter,
						realm: window[sentinelName].realm,
					};
				}, SENTINEL);
				equal(marker, { counter: 1, realm: "MAIN" });
			});
		});

		test("parallel GM.getPageData requests do not cross-talk", async () => {
			await resetPageState();
			const concurrency = CONFIG.transportStress ? 12 : 6;
			const responses = await Promise.all(
				Array.from({ length: concurrency }, (_unused, index) =>
					rawGetPageData(
						async (sentinelName, responseIndex) => {
							await new Promise((resolve) =>
								setTimeout(resolve, 5 * ((responseIndex % 3) + 1)),
							);
							window[sentinelName].counter += 1;
							return {
								responseIndex,
								counter: window[sentinelName].counter,
								realm: window[sentinelName].realm,
							};
						},
						SENTINEL,
						index,
					),
				),
			);
			equal(
				responses.map((item) => item.responseIndex).sort((a, b) => a - b),
				Array.from({ length: concurrency }, (_unused, index) => index),
			);
			equal(
				new Set(responses.map((item) => item.counter)).size,
				concurrency,
				"counters should be unique across concurrent responses",
			);
			ok(
				responses.every((item) => item.realm === "MAIN"),
				"unexpected realm during concurrent transport test",
			);
		}, { optional: !CONFIG.transportStress });

		test("parallel GM.page.call dom.queryText requests stay consistent", async () => {
			const responses = await Promise.all(
				Array.from({ length: CONFIG.transportStress ? 20 : 8 }, () =>
					rawPageCall("dom.queryText", selectorFor(`${FIXTURE_ID}-text`)),
				),
			);
			ok(
				responses.every((item) => item === "MAIN world text ✓"),
				"parallel dom.queryText responses diverged",
			);
		}, { optional: !CONFIG.transportStress });

		test("100 simultaneous GM.getPageData requests complete in stress mode", async () => {
			if (!CONFIG.transportStress) {
				skip("Enable with ?usPageApiStress=1");
			}
			const responses = await Promise.all(
				Array.from({ length: 100 }, (_unused, index) =>
					rawGetPageData((value) => ({ value }), index),
				),
			);
			equal(responses.length, 100);
			equal(
				responses.map((item) => item.value).sort((a, b) => a - b),
				Array.from({ length: 100 }, (_unused, index) => index),
			);
		}, { optional: true, heavy: true });
	}

	function registerSecurityCases() {
		test("getter side effects are blocked for GM.getPageData results", async () => {
			await resetPageState();
			await rejects(
				() =>
					gmGetPageData((sentinelName) => {
						const payload = {};
						Object.defineProperty(payload, "secret", {
							enumerable: true,
							get() {
								window[sentinelName].sideEffectHits.push("getter-result");
								return 123;
							},
						});
						return payload;
					}, SENTINEL),
				["unsupported type", "object must be plain", "descriptor"],
			);
			equal(await sideEffectHits(), []);
		});

		test("setter descriptors are blocked for GM.getPageData results", async () => {
			await resetPageState();
			await rejects(
				() =>
					gmGetPageData((sentinelName) => {
						const payload = {};
						Object.defineProperty(payload, "secret", {
							enumerable: true,
							set(value) {
								window[sentinelName].sideEffectHits.push(`setter-result:${value}`);
							},
						});
						return payload;
					}, SENTINEL),
				["unsupported type", "object must be plain", "descriptor"],
			);
			equal(await sideEffectHits(), []);
		});

		test("Proxy side effects are blocked for GM.getPageData results", async () => {
			await resetPageState();
			await rejects(
				() =>
					gmGetPageData((sentinelName) => {
						return new Proxy(
							{ alpha: 1 },
							{
								ownKeys(target) {
									window[sentinelName].sideEffectHits.push("proxy-ownKeys");
									return Reflect.ownKeys(target);
								},
								getOwnPropertyDescriptor(target, key) {
									window[sentinelName].sideEffectHits.push(`proxy-descriptor:${String(key)}`);
									return Reflect.getOwnPropertyDescriptor(target, key);
								},
							},
						);
					}, SENTINEL),
				["unsupported type", "object must be plain", "proxy"],
			);
			equal(await sideEffectHits(), []);
		}, { optional: !CONFIG.strictExtended });

		test("Function results are blocked for eval/new Function", async () => {
			await rejects(
				() => gmGetPageData(() => eval),
				["unsupported type", "function"],
			);
			await rejects(
				() => gmGetPageData(() => new Function("return 1;")),
				["unsupported type", "function"],
			);
		});

		test("Function arguments are blocked", async () => {
			await rejects(
				() => gmGetPageData((value) => value, eval),
				["value type is not supported", "unsupported type"],
			);
		});

		test("Symbol arguments are blocked", async () => {
			await rejects(
				() => gmGetPageData((value) => value, Symbol("arg-symbol")),
				["value type is not supported", "unsupported type", "symbol"],
			);
		});

		test("event.dispatch rejects polluted detail payloads", async () => {
			await rejects(
				() =>
					gmPageCall("event.dispatch", selectorFor(`${FIXTURE_ID}-event-target`), {
						kind: "custom",
						type: "us-custom-event",
						detail: JSON.parse('{"safe":1,"__proto__":{"polluted":true}}'),
					}),
				["object key is not allowed", "__proto__"],
			);
		});

		test("GM.getPageData does not leak MAIN sentinel into userscript world", async () => {
			ok(
				globalThis[SENTINEL] === undefined,
				"MAIN sentinel leaked into the userscript/content world",
			);
		});

		test("transport does not use postMessage or DOM events as a bridge", async () => {
			await withTransportTrapAssertions("bridge security", async () => {
				await gmGetPageData(() => ({ ok: true }));
				await gmPageCall("dom.queryText", selectorFor(`${FIXTURE_ID}-text`));
			});
		});
	}

	function registerVulnerabilityCases() {
		const collectPageCallSurfaceSummary = () => {
			const operationMatchers = {
				"dom.exists": ["dom.exists"],
				"dom.count": ["dom.count"],
				"dom.queryText": ["dom.queryText"],
				"dom.queryHtml": ["dom.queryHtml"],
				"dom.queryOuterHtml": ["dom.queryOuterHtml"],
				"dom.queryAttr": ["dom.queryAttr returns attributes"],
				"dom.queryProperty": ["dom.queryProperty returns allowlisted properties"],
				"dom.queryRect": ["dom.queryRect returns a rect-like object"],
				"dom.queryClassList": ["dom.queryClassList returns class tokens"],
				"dom.queryAllText": ["dom.queryAllText returns all matching text"],
				"dom.queryAllAttr": ["dom.queryAllAttr returns all matching attributes"],
				"dom.queryAllProperty": [
					"dom.queryAllProperty returns all matching properties",
				],
				"dom.click": ["dom.click"],
				"dom.focus": ["dom.focus and dom.blur update activeElement"],
				"dom.blur": ["dom.focus and dom.blur update activeElement"],
				"dom.setValue": ["dom.setValue updates input value"],
				"dom.setChecked": ["dom.setChecked updates checkbox state"],
				"dom.setSelectedIndex": ["dom.setSelectedIndex updates select state"],
				"event.dispatch": ["event.dispatch"],
				"page.getTitle": ["page getters return page state"],
				"page.getLocation": ["page getters return page state"],
				"page.getReadyState": ["page getters return page state"],
				"page.getVisibility": ["page getters return page state"],
				"page.getSelectionText": ["page getters return page state"],
				"page.snapshot": ["page.snapshot batches supported operations"],
			};
			const summary = Object.create(null);
			for (const [operation, markers] of Object.entries(operationMatchers)) {
				const related = results.filter(
					(item) =>
						Array.isArray(item.group) &&
						item.group[0] === "GM.page.call" &&
						markers.some((marker) => item.name.includes(marker)),
				);
				summary[operation] = {
					statuses: Array.from(new Set(related.map((item) => item.status))),
					passed: related.some((item) => item.status === "PASS"),
					failed: related.some((item) => item.status === "FAIL"),
					warned: related.some((item) => item.status === "WARN"),
					tests: related.map((item) => item.name),
				};
			}
			return summary;
		};

		const collectSafariSpecificIssues = () =>
			results
				.filter(
					(item) =>
						item.status === "WARN" &&
						(
							item.error.includes("executeScript") ||
							item.error.includes("Safari") ||
							item.name.includes("opaque iframe") ||
							item.name.includes("event.dispatch")
						),
				)
				.map((item) => ({
					group: currentGroupLabel(item.group),
					name: item.name,
					reason: item.error.split("\n")[0],
				}));

		test("Runtime", async () => {
			const snapshot = rememberPageApiAvailability();
			const getPageDataSupport = await probeGetPageDataSupport();
			return {
				scriptHandler: snapshot.gmInfoScriptHandler || null,
				version: snapshot.gmInfoVersion || null,
				scriptHandlerVersion: snapshot.gmInfoScriptHandlerVersion || null,
				grant: snapshot.gmInfoScriptGrant,
				injectInto: snapshot.gmInfoScriptInjectInto || null,
				gmKeys: snapshot.gmKeys,
				gmPageKeys: snapshot.gmPageKeys,
				getPageDataStatus: getPageDataSupport.mode,
				getPageDataMessage: getPageDataSupport.message,
			};
		}, { optional: true });

		test("Transport", async () => {
			const getPageDataSupport = await probeGetPageDataSupport();
			let eventDispatch;
			try {
				eventDispatch = await probeEventDispatchSupport();
			} catch (error) {
				eventDispatch = {
					mode: "probe-failed",
					message: formatError(error),
				};
			}
			return {
				inferredTransport: "browser.scripting.executeScript",
				inferenceBasis: [
					"Current Userscripts page API contract uses a browser-mediated MAIN-world path.",
					"GM.page.call DOM operations succeed without exposing a DOM event bridge through the public API.",
				],
				getPageDataStatus: getPageDataSupport.mode,
				eventDispatchStatus: eventDispatch.mode,
				eventDispatchMessage: eventDispatch.message,
				oldBridgeSigns: {
					postMessage: "not observed from public API",
					customEvent: "not observed from public API",
					domEventBridge: "not observed from public API",
				},
				cspSensitivePaths: {
					functionConstructorPath: getPageDataSupport.mode === "supported"
						? "legacy extractor path exposed"
						: "not exposed through current public API",
					stringEvalModel: getPageDataSupport.mode === "supported"
						? "legacy extractor path exposed"
						: "not exposed through current public API",
					arbitraryExtractorSurface: getPageDataSupport.mode,
				},
			};
		}, { optional: true });

		test("Exposure", async () => {
			return {
				gmPageSurface: collectPageCallSurfaceSummary(),
			};
		}, { optional: true });

		test("Known Risks", async () => {
			const getPageDataSupport = await probeGetPageDataSupport();
			let eventDispatch;
			try {
				eventDispatch = await probeEventDispatchSupport();
			} catch (error) {
				eventDispatch = {
					mode: "probe-failed",
					message: formatError(error),
				};
			}
			const reasons = [];
			let level = "Low";
			if (getPageDataSupport.mode === "supported") {
				level = "High";
				reasons.push("Deprecated arbitrary extractor surface is still enabled.");
			} else if (
				eventDispatch.mode === "runtime-error" ||
				eventDispatch.mode === "probe-failed"
			) {
				level = "Medium";
				reasons.push("Safari runtime still has an event.dispatch transport incompatibility.");
			}
			if (
				results.some(
					(item) =>
						item.status === "WARN" && item.name.includes("opaque iframe"),
				)
			) {
				reasons.push("Opaque iframe behavior differs across Safari runtimes.");
			}
			if (!reasons.length) {
				reasons.push(
					"Allowlisted GM.page.call surface is active and deprecated arbitrary page extraction is not exposed.",
				);
			}
			return {
				level,
				reasons,
			};
		}, { optional: true });

		test("Safari-specific Issues", async () => {
			return {
				issues: collectSafariSpecificIssues(),
			};
		}, { optional: true });
	}

	function registerPerformanceCases() {
		test("performance: handles 1 MB string result", async () => {
			const value = await gmGetPageData(() => "x".repeat(1024 * 1024));
			equal(value.length, 1024 * 1024);
			return `returned ${value.length} bytes`;
		});

		test("performance: rejects 10 MB string result", async () => {
			if (!CONFIG.heavyPerf) {
				skip("Enable with ?usPageApiPerf=1");
			}
			await rejects(
				() => gmGetPageData(() => "x".repeat(10 * 1024 * 1024)),
				["too large"],
			);
		}, { heavy: true });

		test("performance: rejects depth-500 plain object", async () => {
			if (!CONFIG.heavyPerf) {
				skip("Enable with ?usPageApiPerf=1");
			}
			await rejects(
				() =>
					gmGetPageData(() => {
						let cursor = { leaf: true };
						for (let depth = 0; depth < 500; depth += 1) {
							cursor = { depth, child: cursor };
						}
						return cursor;
					}),
				["maximum depth", "depth"],
			);
		}, { heavy: true });

		test("performance: rejects array with 100000 elements", async () => {
			if (!CONFIG.heavyPerf) {
				skip("Enable with ?usPageApiPerf=1");
			}
			await rejects(
				() =>
					gmGetPageData(() =>
						Array.from({ length: 100000 }, (_unused, index) => index),
					),
				["array is too large", "too large"],
			);
		}, { heavy: true });

		test("performance: 100 GM.getPageData round-trips", async () => {
			const loopCount = CONFIG.heavyPerf ? 1000 : 100;
			const started = performance.now();
			for (let index = 0; index < loopCount; index += 1) {
				equal(await gmGetPageData((value) => value + 1, index), index + 1);
			}
			const duration = performance.now() - started;
			return `${loopCount} calls in ${duration.toFixed(1)} ms`;
		}, { heavy: CONFIG.heavyPerf });

		test("performance: 100 GM.page.call round-trips", async () => {
			const loopCount = CONFIG.heavyPerf ? 1000 : 100;
			const started = performance.now();
			for (let index = 0; index < loopCount; index += 1) {
				equal(
					await gmPageCall("dom.queryText", selectorFor(`${FIXTURE_ID}-text`)),
					"MAIN world text ✓",
				);
			}
			const duration = performance.now() - started;
			return `${loopCount} calls in ${duration.toFixed(1)} ms`;
		}, { heavy: CONFIG.heavyPerf });
	}

	const currentGroup = [];
	const panel = installReportPanel();
	publishLiveReport("Running…");

	group("Environment", () => {
		test("API surface exists", async () => {
			const snapshot = rememberPageApiAvailability();
			if (!snapshot.ok) {
				throw new AbortSuiteError(
					`Missing page API surface in current runtime: ${summarizeMissingPageApi(
						snapshot,
					)}. Runtime diagnostics: ${summarizePageApiDiagnostics(
						snapshot,
					)}. This usually means Userscripts did not inject the granted API on this page. If you edited the userscript outside the built-in editor, open the Userscripts popup once and let it fully load, then reload the page and rerun the suite.`,
				);
			}
		});

		test("local fixture setup for GM.page.call", async () => {
			const value = await setupLocalFixture();
			equal(value.fixtureCreated, true);
			equal(value.fixtureRealm, "content");
			equal(value.documentType, "HTMLDocument");
			ok(typeof value.weirdId === "string" && value.weirdId.includes(FIXTURE_ID));
		});

		test("same-origin iframe variants are attached", async () => {
			const meta = await localFixtureMeta();
			ok(meta.iframes.aboutBlankAccessible, "about:blank iframe should be accessible");
			ok(meta.iframes.srcdocAccessible, "srcdoc iframe should be accessible");
		});

		test("opaque iframe variants are attached", async () => {
			const meta = await localFixtureMeta();
			if (!meta.iframes.sandboxOpaque || !meta.iframes.dataOpaque) {
				throw new Error(
					`Opaque iframe behavior differs on this Safari runtime: sandboxOpaque=${meta.iframes.sandboxOpaque}, dataOpaque=${meta.iframes.dataOpaque}`,
				);
			}
		}, { optional: true });
	});

	group("Deprecated / GM.getPageData", () => {
		group("Allowed", () => {
			registerPrimitiveCases();
		});
		group("Rejected", () => {
			registerUnsupportedResultCases();
		});
	});

	group("GM.page.call", () => {
		group("DOM", () => {
			registerPageCallCases();
		});
		group("Events", () => {
			registerEventDispatchCases();
		});
	});

	group("Transport", () => {
		registerTransportCases();
	});

	group("Security", () => {
		registerSecurityCases();
	});

	group("Vulnerabilities", () => {
		registerVulnerabilityCases();
	});

	group("Performance", () => {
		registerPerformanceCases();
	});

	console.group(SUITE);

	for (let testIndex = 0; testIndex < tests.length; testIndex += 1) {
		const entry = tests[testIndex];
		const started = performance.now();
		renderInterim(panel, `[${currentGroupLabel(entry.group)}] ${entry.name}`);
		try {
			const detail = await entry.fn();
			const duration = performance.now() - started;
			results.push({
				name: entry.name,
				group: entry.group,
				status: "PASS",
				duration,
				detail:
					typeof detail === "string" ? detail : detail ? format(detail) : "",
			});
			console.log(
				`${PREFIX} PASS [${currentGroupLabel(entry.group)}] ${entry.name} (${duration.toFixed(1)} ms)`,
			);
			renderInterim(
				panel,
				`[${currentGroupLabel(entry.group)}] ${entry.name} -> PASS`,
			);
			publishLiveReport(
				`${results.length}/${tests.length} complete | [${currentGroupLabel(
					entry.group,
				)}] ${entry.name} -> PASS`,
			);
		} catch (error) {
			const duration = performance.now() - started;
			let status = "FAIL";
			if (error instanceof SkipTest) {
				status = "SKIP";
			} else if (entry.optional) {
				status = "WARN";
			}
			results.push({
				name: entry.name,
				group: entry.group,
				status,
				duration,
				detail: entry.heavy ? "heavy-path" : "",
				error: formatError(error),
			});
			console[status === "FAIL" ? "error" : "warn"](
				`${PREFIX} ${status} [${currentGroupLabel(entry.group)}] ${entry.name}`,
				error,
			);
			renderInterim(
				panel,
				`[${currentGroupLabel(entry.group)}] ${entry.name} -> ${status}`,
			);
			publishLiveReport(
				`${results.length}/${tests.length} complete | [${currentGroupLabel(
					entry.group,
				)}] ${entry.name} -> ${status}`,
			);
			if (error instanceof AbortSuiteError) {
				for (const skippedEntry of tests.slice(testIndex + 1)) {
					results.push({
						name: skippedEntry.name,
						group: skippedEntry.group,
						status: "SKIP",
						duration: 0,
						detail: `aborted: ${error.message}`,
						error: "",
					});
				}
				renderInterim(
					panel,
					`Aborted | ${error.message}`,
				);
				publishLiveReport(
					`Aborted | ${error.message}`,
				);
				break;
			}
		}
	}

	const duration = performance.now() - startedAt;
	const passed = results.filter((item) => item.status === "PASS").length;
	const failed = results.filter((item) => item.status === "FAIL").length;
	const warned = results.filter((item) => item.status === "WARN").length;
	const skipped = results.filter((item) => item.status === "SKIP").length;
	const summary = `${passed} passed, ${failed} failed, ${warned} warnings, ${skipped} skipped — ${duration.toFixed(
		1,
	)} ms`;

	const groupSummaries = Array.from(
		results.reduce((map, item) => {
			const key = currentGroupLabel(item.group);
			if (!map.has(key)) {
				map.set(key, { pass: 0, fail: 0, warn: 0, skip: 0 });
			}
			const bucket = map.get(key);
			if (item.status === "PASS") bucket.pass += 1;
			if (item.status === "FAIL") bucket.fail += 1;
			if (item.status === "WARN") bucket.warn += 1;
			if (item.status === "SKIP") bucket.skip += 1;
			return map;
		}, new Map()),
	)
		.map(([name, counts]) => {
			return `${name}: ${counts.pass} pass, ${counts.fail} fail, ${counts.warn} warn, ${counts.skip} skip`;
		})
		.sort();

	const isDeprecatedResult = (item) =>
		Array.isArray(item.group) && item.group[0] === "Deprecated / GM.getPageData";
	const summarizeStatusCounts = (items) => {
		const counts = { pass: 0, fail: 0, warn: 0, skip: 0 };
		for (const item of items) {
			if (item.status === "PASS") counts.pass += 1;
			if (item.status === "FAIL") counts.fail += 1;
			if (item.status === "WARN") counts.warn += 1;
			if (item.status === "SKIP") counts.skip += 1;
		}
		return counts;
	};
	const deprecatedCounts = summarizeStatusCounts(results.filter(isDeprecatedResult));
	const supportedPassed = results.filter(
		(item) => item.status === "PASS" && !isDeprecatedResult(item),
	).length;
	const supportedFailed = results.filter(
		(item) => item.status === "FAIL" && !isDeprecatedResult(item),
	).length;
	const runtimeSpecificWarnings = results.filter((item) => item.status === "WARN").length;
	const categorySummaries = [
		`supported and passed: ${supportedPassed}`,
		`supported but failed: ${supportedFailed}`,
		`deprecated/incompatible: ${deprecatedCounts.pass} pass, ${deprecatedCounts.fail} fail, ${deprecatedCounts.warn} warn, ${deprecatedCounts.skip} skip`,
		`runtime-specific warnings: ${runtimeSpecificWarnings}`,
	];

	const report = [
		SUITE,
		`Version: ${BUILD}`,
		`URL: ${location.href}`,
		`Time: ${new Date().toISOString()}`,
		`Mode: strictExtended=${CONFIG.strictExtended ? 1 : 0}, heavyPerf=${CONFIG.heavyPerf ? 1 : 0}, transportStress=${CONFIG.transportStress ? 1 : 0}`,
		`Result: ${summary}`,
		"",
		"Groups:",
		...groupSummaries,
		"",
		"Categories:",
		...categorySummaries,
		"",
		...results.map((item, index) => {
			const header = `${String(index + 1).padStart(3, "0")}. ${
				item.status
			} [${currentGroupLabel(item.group)}] ${item.name} (${item.duration.toFixed(
				1,
			)} ms)`;
			return [header, item.detail, item.error].filter(Boolean).join("\n");
		}),
	].join("\n");

	panel.querySelector('[data-role="summary"]').textContent = summary;
	panel.querySelector('[data-role="summary"]').style.fontWeight = "bold";
	panel.querySelector('[data-role="active"]').textContent = `Finished | ${summary}`;
	panel.querySelector('[data-role="report"]').textContent = report;
	panel.querySelector('[data-role="report-wrap"]').open = true;
	panel.style.borderColor = failed ? "#d33" : warned ? "#c90" : "#2a6";

	console.log(`${PREFIX} ${summary}`);
	console.log(report);
	console.groupEnd();

	globalThis.__US_PAGE_API_TEST_REPORT__ = Object.freeze({
		...buildLiveReport(summary),
		summary,
		passed,
		failed,
		warned,
		skipped,
		duration,
	});

	const cleanup = await cleanupLocalFixture();
	if (!cleanup.fixturePresent && !cleanup.sentinelPresent) {
		console.log(`${PREFIX} Cleanup complete`);
	}

	if (failed) {
		throw new Error(`${SUITE}: ${summary}`);
	}
})();
