import { contentScriptRegistration, openExtensionPage } from "@ext/utils.js";
import * as settingsStorage from "@ext/settings.js";
import { connectNative, sendNativeMessage } from "@ext/native.js";

const BACKGROUND_XHR_ALLOWED_METHODS = new Set([
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
]);
const BACKGROUND_XHR_ALLOWED_RESPONSE_TYPES = new Set([
	"",
	"text",
	"json",
	"blob",
	"arraybuffer",
	"document",
]);
const BACKGROUND_XHR_FORBIDDEN_HEADERS = new Set([
	"authorization",
	"connection",
	"content-length",
	"cookie",
	"cookie2",
	"host",
	"origin",
	"proxy-authorization",
	"proxy-connection",
	"referer",
	"www-authenticate",
]);
const BACKGROUND_XHR_FORBIDDEN_HEADER_PREFIXES = ["proxy-", "sec-"];
const BACKGROUND_XHR_MAX_TIMEOUT_MS = 120_000;
const BACKGROUND_XHR_MAX_HEADER_COUNT = 64;
const BACKGROUND_XHR_MAX_HEADER_VALUE_LENGTH = 8192;
const BACKGROUND_XHR_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const BACKGROUND_PAGE_DATA_MAX_DEPTH = 32;
const BACKGROUND_PAGE_DATA_MAX_ARRAY_LENGTH = 4096;
const BACKGROUND_PAGE_DATA_MAX_OBJECT_KEYS = 128;
const BACKGROUND_PAGE_DATA_MAX_OBJECT_KEY_LENGTH = 512;
const BACKGROUND_PAGE_CALL_MAX_ARGS_BYTES = 64 * 1024;
const BACKGROUND_PAGE_CALL_MAX_RESULT_BYTES = 256 * 1024;
const BACKGROUND_PAGE_CALL_MAX_OPERATION_LENGTH = 64;
const BACKGROUND_PAGE_CALL_MAX_SELECTOR_LENGTH = 4096;
const BACKGROUND_PAGE_CALL_MAX_ATTRIBUTE_LENGTH = 128;
const BACKGROUND_PAGE_CALL_MAX_PROPERTY_LENGTH = 64;
const BACKGROUND_PAGE_CALL_MAX_VALUE_LENGTH = 8192;
const BACKGROUND_PAGE_CALL_MAX_EVENT_TYPE_LENGTH = 128;
const BACKGROUND_PAGE_CALL_MAX_EVENT_STRING_LENGTH = 512;
const BACKGROUND_PAGE_CALL_MAX_SNAPSHOT_QUERIES = 32;
const BACKGROUND_PAGE_CALL_MAX_SNAPSHOT_KEY_LENGTH = 128;
const BACKGROUND_PAGE_CALL_ALLOWED_OPERATIONS = new Set([
	"dom.exists",
	"dom.count",
	"dom.queryText",
	"dom.queryHtml",
	"dom.queryOuterHtml",
	"dom.queryAttr",
	"dom.queryProperty",
	"dom.queryRect",
	"dom.queryClassList",
	"dom.queryAllText",
	"dom.queryAllAttr",
	"dom.queryAllProperty",
	"dom.click",
	"dom.focus",
	"dom.blur",
	"dom.setValue",
	"dom.setChecked",
	"dom.setSelectedIndex",
	"event.dispatch",
	"page.getTitle",
	"page.getLocation",
	"page.getReadyState",
	"page.getVisibility",
	"page.getSelectionText",
	"page.snapshot",
]);
const BACKGROUND_PAGE_CALL_ALLOWED_PROPERTIES = new Set([
	"value",
	"checked",
	"disabled",
	"selectedIndex",
	"href",
	"src",
	"title",
	"id",
	"name",
	"type",
	"placeholder",
	"lang",
	"dir",
	"textContent",
	"innerText",
	"className",
	"ariaLabel",
	"tabIndex",
]);
const BACKGROUND_PAGE_CALL_ALLOWED_LOCATION_FIELDS = Object.freeze([
	"href",
	"origin",
	"protocol",
	"host",
	"hostname",
	"pathname",
	"search",
	"hash",
]);
const BACKGROUND_PAGE_CALL_ALLOWED_LOCATION_FIELD_SET = new Set(
	BACKGROUND_PAGE_CALL_ALLOWED_LOCATION_FIELDS,
);
const BACKGROUND_PAGE_CALL_ALLOWED_SNAPSHOT_QUERY_KINDS = new Set([
	"text",
	"html",
	"outerHtml",
	"attr",
	"property",
	"exists",
	"rect",
	"classList",
	"allText",
	"allAttr",
	"allProperty",
	"count",
]);
const BACKGROUND_XHR_HANDLER_NAMES = new Set([
	"onreadystatechange",
	"onloadstart",
	"onprogress",
	"onabort",
	"onerror",
	"onload",
	"ontimeout",
	"onloadend",
]);
const BACKGROUND_XHR_UPLOAD_HANDLER_NAMES = new Set([
	"onabort",
	"onerror",
	"onload",
	"onloadend",
	"onloadstart",
	"onprogress",
	"ontimeout",
]);
const backgroundTextEncoder =
	typeof TextEncoder === "function" ? new TextEncoder() : null;

function backgroundByteLength(value) {
	const text = String(value ?? "");
	if (backgroundTextEncoder) {
		return backgroundTextEncoder.encode(text).byteLength;
	}
	return text.length * 2;
}

function backgroundIsPlainObject(value) {
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

function formatBackgroundPageTaskError(error, fallbackMessage = "Page task failed") {
	if (typeof error?.stack === "string" && error.stack) {
		return error.stack;
	}
	if (typeof error?.message === "string" && error.message) {
		return error.message;
	}
	if (typeof error === "string" && error) {
		return error;
	}
	return fallbackMessage;
}

function createBackgroundPageTaskConfig(maxResultBytes, oversizedResultMessage) {
	return {
		maxDepth: BACKGROUND_PAGE_DATA_MAX_DEPTH,
		maxArrayLength: BACKGROUND_PAGE_DATA_MAX_ARRAY_LENGTH,
		maxObjectKeys: BACKGROUND_PAGE_DATA_MAX_OBJECT_KEYS,
		maxObjectKeyLength: BACKGROUND_PAGE_DATA_MAX_OBJECT_KEY_LENGTH,
		maxResultBytes,
		oversizedResultMessage,
	};
}

function backgroundIsSafePageObjectKey(key) {
	return (
		key !== "__proto__" &&
		key !== "prototype" &&
		key !== "constructor"
	);
}

function backgroundNormalizePageSerializableValue(
	value,
	depth = 0,
	seen = new WeakSet(),
) {
	if (depth > BACKGROUND_PAGE_DATA_MAX_DEPTH) {
		throw new Error("page value exceeds maximum depth");
	}
	if (value === null) return null;
	switch (typeof value) {
		case "string":
		case "boolean":
			return value;
		case "number":
			if (!Number.isFinite(value)) {
				throw new Error("page numeric value must be finite");
			}
			return value;
		case "object":
			break;
		default:
			throw new Error("page value type is not supported");
	}
	if (seen.has(value)) {
		throw new Error("page value must not contain cycles");
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > BACKGROUND_PAGE_DATA_MAX_ARRAY_LENGTH) {
				throw new Error("page array is too large");
			}
			return value.map((item) =>
				backgroundNormalizePageSerializableValue(item, depth + 1, seen),
			);
		}
		if (!backgroundIsPlainObject(value)) {
			throw new Error("page object must be plain");
		}
		const result = Object.create(null);
		const entries = Object.entries(value);
		if (entries.length > BACKGROUND_PAGE_DATA_MAX_OBJECT_KEYS) {
			throw new Error("page object has too many keys");
		}
		for (const [key, entryValue] of entries) {
			if (key.length > BACKGROUND_PAGE_DATA_MAX_OBJECT_KEY_LENGTH) {
				throw new Error("page object key is too long");
			}
			if (!backgroundIsSafePageObjectKey(key)) {
				throw new Error("page object key is not allowed");
			}
			result[key] = backgroundNormalizePageSerializableValue(
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

function backgroundNormalizePageCallString(value, label, maxLength = Infinity) {
	if (typeof value !== "string" || !value.length) {
		throw new Error(`${label} must be a non-empty string`);
	}
	if (value.length > maxLength) {
		throw new Error(`${label} is too long`);
	}
	return value;
}

function backgroundNormalizePageCallInteger(value, label, minimum = -Infinity) {
	if (!Number.isInteger(value) || value < minimum) {
		throw new Error(`${label} must be an integer`);
	}
	return value;
}

function backgroundNormalizePageCallBoolean(value, label) {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a boolean`);
	}
	return value;
}

function backgroundNormalizePageCallNumber(value, label) {
	if (!Number.isFinite(value)) {
		throw new Error(`${label} must be a finite number`);
	}
	return value;
}

function backgroundNormalizePageCallSelector(selector) {
	if (typeof selector !== "string" || !selector.trim()) {
		throw new Error("page.call selector must be a non-empty string");
	}
	if (selector.length > BACKGROUND_PAGE_CALL_MAX_SELECTOR_LENGTH) {
		throw new Error("page.call selector is too long");
	}
	return selector;
}

function backgroundNormalizePageCallAttribute(attribute) {
	if (typeof attribute !== "string" || !attribute.trim()) {
		throw new Error("page.call attribute must be a non-empty string");
	}
	if (attribute.length > BACKGROUND_PAGE_CALL_MAX_ATTRIBUTE_LENGTH) {
		throw new Error("page.call attribute is too long");
	}
	return attribute;
}

function backgroundNormalizePageCallProperty(property) {
	const normalizedProperty = backgroundNormalizePageCallString(
		property,
		"page.call property",
		BACKGROUND_PAGE_CALL_MAX_PROPERTY_LENGTH,
	);
	if (!BACKGROUND_PAGE_CALL_ALLOWED_PROPERTIES.has(normalizedProperty)) {
		throw new Error(`DOM property is not allowed: ${normalizedProperty}`);
	}
	return normalizedProperty;
}

function backgroundNormalizePageCallValue(value) {
	return backgroundNormalizePageCallString(
		value,
		"page.call value",
		BACKGROUND_PAGE_CALL_MAX_VALUE_LENGTH,
	);
}

function backgroundNormalizePageCallEventSpec(spec) {
	const normalizedSpec = backgroundNormalizePageSerializableValue(spec);
	if (!backgroundIsPlainObject(normalizedSpec)) {
		throw new Error("page.call event spec must be a plain object");
	}
	const hasOwn = (key) =>
		Object.prototype.hasOwnProperty.call(normalizedSpec, key);
	const kind = hasOwn("kind")
		? backgroundNormalizePageCallString(
				normalizedSpec.kind,
				"page.call event kind",
				BACKGROUND_PAGE_CALL_MAX_EVENT_STRING_LENGTH,
			)
		: "event";
	if (!new Set(["event", "custom", "mouse", "keyboard", "input"]).has(kind)) {
		throw new Error(`page.call unsupported event kind: ${kind}`);
	}
	const type = backgroundNormalizePageCallString(
		normalizedSpec.type,
		"page.call event type",
		BACKGROUND_PAGE_CALL_MAX_EVENT_TYPE_LENGTH,
	);
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
		result.bubbles = backgroundNormalizePageCallBoolean(
			normalizedSpec.bubbles,
			"page.call event bubbles",
		);
	}
	if (hasOwn("cancelable")) {
		result.cancelable = backgroundNormalizePageCallBoolean(
			normalizedSpec.cancelable,
			"page.call event cancelable",
		);
	}
	if (hasOwn("composed")) {
		result.composed = backgroundNormalizePageCallBoolean(
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
				result[key] = backgroundNormalizePageCallNumber(
					normalizedSpec[key],
					`page.call event ${key}`,
				);
			}
		}
		for (const key of ["ctrlKey", "shiftKey", "altKey", "metaKey"]) {
			if (hasOwn(key)) {
				result[key] = backgroundNormalizePageCallBoolean(
					normalizedSpec[key],
					`page.call event ${key}`,
				);
			}
		}
	}
	if (kind === "keyboard") {
		for (const key of ["key", "code"]) {
			if (hasOwn(key)) {
				result[key] = backgroundNormalizePageCallString(
					normalizedSpec[key],
					`page.call event ${key}`,
					BACKGROUND_PAGE_CALL_MAX_EVENT_STRING_LENGTH,
				);
			}
		}
		if (hasOwn("location")) {
			result.location = backgroundNormalizePageCallNumber(
				normalizedSpec.location,
				"page.call event location",
			);
		}
		for (const key of ["repeat", "ctrlKey", "shiftKey", "altKey", "metaKey"]) {
			if (hasOwn(key)) {
				result[key] = backgroundNormalizePageCallBoolean(
					normalizedSpec[key],
					`page.call event ${key}`,
				);
			}
		}
	}
	if (kind === "input") {
		for (const key of ["data", "inputType"]) {
			if (hasOwn(key)) {
				result[key] = backgroundNormalizePageCallString(
					normalizedSpec[key],
					`page.call event ${key}`,
					BACKGROUND_PAGE_CALL_MAX_EVENT_STRING_LENGTH,
				);
			}
		}
		if (hasOwn("isComposing")) {
			result.isComposing = backgroundNormalizePageCallBoolean(
				normalizedSpec.isComposing,
				"page.call event isComposing",
			);
		}
	}
	return result;
}

function backgroundNormalizePageCallLocationFields(locationValue) {
	if (locationValue === true) {
		return [...BACKGROUND_PAGE_CALL_ALLOWED_LOCATION_FIELDS];
	}
	if (!Array.isArray(locationValue) || locationValue.length === 0) {
		throw new Error(
			"page.call page.snapshot location must be true or a non-empty array",
		);
	}
	const fields = [];
	const seen = new Set();
	for (const value of locationValue) {
		const field = backgroundNormalizePageCallString(
			value,
			"page.call location field",
			BACKGROUND_PAGE_CALL_MAX_PROPERTY_LENGTH,
		);
		if (!BACKGROUND_PAGE_CALL_ALLOWED_LOCATION_FIELD_SET.has(field)) {
			throw new Error(`page.call location field is not allowed: ${field}`);
		}
		if (seen.has(field)) continue;
		seen.add(field);
		fields.push(field);
	}
	return fields;
}

function backgroundNormalizePageCallSnapshotQuerySpec(spec) {
	const normalizedSpec = backgroundNormalizePageSerializableValue(spec);
	if (!backgroundIsPlainObject(normalizedSpec)) {
		throw new Error("page.call page.snapshot query spec must be a plain object");
	}
	const kind = backgroundNormalizePageCallString(
		normalizedSpec.kind,
		"page.call page.snapshot query kind",
		BACKGROUND_PAGE_CALL_MAX_EVENT_STRING_LENGTH,
	);
	if (!BACKGROUND_PAGE_CALL_ALLOWED_SNAPSHOT_QUERY_KINDS.has(kind)) {
		throw new Error(`page.call page.snapshot query kind is not allowed: ${kind}`);
	}
	const result = Object.create(null);
	result.kind = kind;
	result.selector = backgroundNormalizePageCallSelector(normalizedSpec.selector);
	if (
		["text", "html", "outerHtml", "exists", "rect", "classList", "allText", "count"].includes(
			kind,
		)
	) {
		if (Object.keys(normalizedSpec).some((key) => !["kind", "selector"].includes(key))) {
			throw new Error(
				`page.call page.snapshot ${kind} query has unsupported keys`,
			);
		}
		return result;
	}
	if (["attr", "allAttr"].includes(kind)) {
		if (
			Object.keys(normalizedSpec).some(
				(key) => !["kind", "selector", "attribute"].includes(key),
			)
		) {
			throw new Error(
				`page.call page.snapshot ${kind} query has unsupported keys`,
			);
		}
		result.attribute = backgroundNormalizePageCallAttribute(normalizedSpec.attribute);
		return result;
	}
	if (["property", "allProperty"].includes(kind)) {
		if (
			Object.keys(normalizedSpec).some(
				(key) => !["kind", "selector", "property"].includes(key),
			)
		) {
			throw new Error(
				`page.call page.snapshot ${kind} query has unsupported keys`,
			);
		}
		result.property = backgroundNormalizePageCallProperty(normalizedSpec.property);
		return result;
	}
	if (
		Object.keys(normalizedSpec).some(
			(key) => !["kind", "selector"].includes(key),
		)
	) {
		throw new Error(`page.call page.snapshot ${kind} query has unsupported keys`);
	}
	return result;
}

function backgroundNormalizePageCallSnapshotSpec(spec) {
	const normalizedSpec = backgroundNormalizePageSerializableValue(spec);
	if (!backgroundIsPlainObject(normalizedSpec)) {
		throw new Error("page.call page.snapshot spec must be a plain object");
	}
	const allowedKeys = new Set([
		"title",
		"location",
		"readyState",
		"visibility",
		"selectionText",
		"queries",
	]);
	for (const key of Object.keys(normalizedSpec)) {
		if (!allowedKeys.has(key)) {
			throw new Error(`page.call page.snapshot spec key is not allowed: ${key}`);
		}
	}
	const hasOwn = (key) =>
		Object.prototype.hasOwnProperty.call(normalizedSpec, key);
	const result = Object.create(null);
	if (hasOwn("title")) {
		result.title = backgroundNormalizePageCallBoolean(
			normalizedSpec.title,
			"page.call page.snapshot title",
		);
	}
	if (hasOwn("location")) {
		result.location = backgroundNormalizePageCallLocationFields(
			normalizedSpec.location,
		);
	}
	if (hasOwn("readyState")) {
		result.readyState = backgroundNormalizePageCallBoolean(
			normalizedSpec.readyState,
			"page.call page.snapshot readyState",
		);
	}
	if (hasOwn("visibility")) {
		result.visibility = backgroundNormalizePageCallBoolean(
			normalizedSpec.visibility,
			"page.call page.snapshot visibility",
		);
	}
	if (hasOwn("selectionText")) {
		result.selectionText = backgroundNormalizePageCallBoolean(
			normalizedSpec.selectionText,
			"page.call page.snapshot selectionText",
		);
	}
	if (hasOwn("queries")) {
		const queries = normalizedSpec.queries;
		if (!backgroundIsPlainObject(queries)) {
			throw new Error("page.call page.snapshot queries must be a plain object");
		}
		const entries = Object.entries(queries);
		if (entries.length > BACKGROUND_PAGE_CALL_MAX_SNAPSHOT_QUERIES) {
			throw new Error("page.call page.snapshot has too many queries");
		}
		const normalizedQueries = Object.create(null);
		for (const [key, value] of entries) {
			if (!key.length) {
				throw new Error("page.call page.snapshot query key must not be empty");
			}
			if (key.length > BACKGROUND_PAGE_CALL_MAX_SNAPSHOT_KEY_LENGTH) {
				throw new Error("page.call page.snapshot query key is too long");
			}
			if (!backgroundIsSafePageObjectKey(key)) {
				throw new Error("page.call page.snapshot query key is not allowed");
			}
			normalizedQueries[key] = backgroundNormalizePageCallSnapshotQuerySpec(value);
		}
		result.queries = normalizedQueries;
	}
	if (!Object.keys(result).length) {
		throw new Error("page.call page.snapshot spec must request at least one field");
	}
	return result;
}

function backgroundNormalizePageCallArgs(operation, args) {
	if (!Array.isArray(args)) {
		throw new Error("page.call arguments must be an array");
	}
	switch (operation) {
		case "dom.exists":
		case "dom.count":
		case "dom.queryText":
		case "dom.queryHtml":
		case "dom.queryOuterHtml":
		case "dom.queryRect":
		case "dom.queryClassList":
		case "dom.queryAllText":
		case "dom.click":
		case "dom.focus":
		case "dom.blur":
			if (args.length !== 1) {
				throw new Error(`page.call ${operation} expects exactly 1 argument`);
			}
			return [backgroundNormalizePageCallSelector(args[0])];
		case "dom.queryAttr":
		case "dom.queryAllAttr":
			if (args.length !== 2) {
				throw new Error(`page.call ${operation} expects exactly 2 arguments`);
			}
			return [
				backgroundNormalizePageCallSelector(args[0]),
				backgroundNormalizePageCallAttribute(args[1]),
			];
		case "dom.queryProperty":
		case "dom.queryAllProperty":
			if (args.length !== 2) {
				throw new Error(`page.call ${operation} expects exactly 2 arguments`);
			}
			return [
				backgroundNormalizePageCallSelector(args[0]),
				backgroundNormalizePageCallProperty(args[1]),
			];
		case "dom.setValue":
			if (args.length !== 2) {
				throw new Error("page.call dom.setValue expects exactly 2 arguments");
			}
			return [
				backgroundNormalizePageCallSelector(args[0]),
				backgroundNormalizePageCallValue(args[1]),
			];
		case "dom.setChecked":
			if (args.length !== 2) {
				throw new Error("page.call dom.setChecked expects exactly 2 arguments");
			}
			return [
				backgroundNormalizePageCallSelector(args[0]),
				backgroundNormalizePageCallBoolean(args[1], "page.call checked"),
			];
		case "dom.setSelectedIndex":
			if (args.length !== 2) {
				throw new Error(
					"page.call dom.setSelectedIndex expects exactly 2 arguments",
				);
			}
			return [
				backgroundNormalizePageCallSelector(args[0]),
				backgroundNormalizePageCallInteger(
					args[1],
					"page.call selectedIndex",
					-1,
				),
			];
		case "event.dispatch":
			if (args.length !== 2) {
				throw new Error("page.call event.dispatch expects exactly 2 arguments");
			}
			return [
				backgroundNormalizePageCallSelector(args[0]),
				backgroundNormalizePageCallEventSpec(args[1]),
			];
		case "page.getTitle":
		case "page.getLocation":
		case "page.getReadyState":
		case "page.getVisibility":
		case "page.getSelectionText":
			if (args.length !== 0) {
				throw new Error(`page.call ${operation} expects exactly 0 arguments`);
			}
			return [];
		case "page.snapshot":
			if (args.length !== 1) {
				throw new Error("page.call page.snapshot expects exactly 1 argument");
			}
			return [backgroundNormalizePageCallSnapshotSpec(args[0])];
		default:
			throw new Error(`Unsupported page operation: ${operation}`);
	}
}

function normalizeBackgroundPageTask(task) {
	if (!backgroundIsPlainObject(task)) {
		throw new Error("Invalid page task");
	}
	if (task.kind === "getPageData") {
		throw new Error(
			"GM.getPageData(extractor) is no longer supported. Use GM.page.call(operation, ...args).",
		);
	}
	if (task.kind !== "pageCall") {
		throw new Error("Unsupported page task");
	}
	if (
		typeof task.operation !== "string" ||
		!task.operation.length ||
		task.operation.length > BACKGROUND_PAGE_CALL_MAX_OPERATION_LENGTH
	) {
		throw new Error("Invalid page operation");
	}
	if (!BACKGROUND_PAGE_CALL_ALLOWED_OPERATIONS.has(task.operation)) {
		throw new Error("Unsupported page operation");
	}
	if (typeof task.argsJson !== "string") {
		throw new Error("Invalid page.call arguments");
	}
	if (backgroundByteLength(task.argsJson) > BACKGROUND_PAGE_CALL_MAX_ARGS_BYTES) {
		throw new Error("page.call arguments are too large");
	}
	let parsedArgs;
	try {
		parsedArgs = JSON.parse(task.argsJson);
	} catch {
		throw new Error("Invalid page.call arguments");
	}
	return {
		kind: task.kind,
		args: backgroundNormalizePageCallArgs(task.operation, parsedArgs),
		maxResultBytes: BACKGROUND_PAGE_CALL_MAX_RESULT_BYTES,
		operation: task.operation,
		oversizedResultMessage: "page.call result is too large",
	};
}

function executeMainWorldPageCallTask(
	operation,
	args,
	config,
) {
	const {
		maxDepth,
		maxArrayLength,
		maxObjectKeys,
		maxObjectKeyLength,
		maxResultBytes,
		oversizedResultMessage,
	} = config;
	const byteLength = (value) => {
		const text = String(value ?? "");
		if (typeof TextEncoder === "function") {
			return new TextEncoder().encode(text).byteLength;
		}
		return text.length * 2;
	};
	const isPlainObject = (value) => {
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
	const isSafeKey = (key) =>
		key !== "__proto__" &&
		key !== "prototype" &&
		key !== "constructor";
	const normalize = (value, depth = 0, seen = new WeakSet()) => {
		if (depth > maxDepth) {
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
				if (value.length > maxArrayLength) {
					throw new Error("Page data result array is too large");
				}
				return value.map((item) => normalize(item, depth + 1, seen));
			}
			if (!isPlainObject(value)) {
				throw new Error("Page data result object must be plain");
			}
			const entries = Object.entries(value);
			if (entries.length > maxObjectKeys) {
				throw new Error("Page data result object has too many keys");
			}
			const result = Object.create(null);
			for (const [key, entryValue] of entries) {
				if (key.length > maxObjectKeyLength) {
					throw new Error("Page data result object key is too long");
				}
				if (!isSafeKey(key)) {
					throw new Error("Page data result object key is not allowed");
				}
				result[key] = normalize(entryValue, depth + 1, seen);
			}
			return result;
		} finally {
			seen.delete(value);
		}
	};
	const fail = (error) => ({
		ok: false,
		error: String(error?.message || error),
	});
	const success = (value) => {
		const normalized = normalize(value);
		const json = JSON.stringify(normalized);
		if (byteLength(json) > maxResultBytes) {
			throw new Error(oversizedResultMessage);
		}
		return {
			ok: true,
			value: normalized,
		};
	};
	const selectTarget = (selector) => {
		if (typeof selector !== "string" || !selector) {
			throw new Error("Invalid page selector");
		}
		return document.querySelector(selector);
	};
	const selectTargets = (selector) => {
		if (typeof selector !== "string" || !selector) {
			throw new Error("Invalid page selector");
		}
		return Array.from(document.querySelectorAll(selector));
	};
	const readText = (target) => (target ? String(target.textContent ?? "") : null);
	const readHtml = (target) => (target ? String(target.innerHTML ?? "") : null);
	const readOuterHtml = (target) =>
		(target ? String(target.outerHTML ?? "") : null);
	const readAttribute = (target, attribute) => {
		if (!target || typeof target.getAttribute !== "function") {
			return null;
		}
		return target.getAttribute(attribute);
	};
	const readProperty = (target, property) =>
		(target ? target[property] ?? null : null);
	const readRect = (target) => {
		if (!target || typeof target.getBoundingClientRect !== "function") {
			return null;
		}
		const rect = target.getBoundingClientRect();
		if (!rect) {
			return null;
		}
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
	};
	const readClassList = (target) => {
		if (!target) {
			return null;
		}
		if (target.classList && typeof target.classList[Symbol.iterator] === "function") {
			return Array.from(target.classList, (token) => String(token));
		}
		if (typeof target.className === "string") {
			return target.className.split(/\s+/).filter(Boolean);
		}
		return [];
	};
	const readSelectionText = () => {
		const selection = globalThis.getSelection?.();
		return selection ? String(selection.toString()) : "";
	};
	const buildEvent = (spec) => {
		if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
			throw new Error("Invalid event spec");
		}
		const init = {
			bubbles: Boolean(spec.bubbles),
			cancelable: Boolean(spec.cancelable),
			composed: Boolean(spec.composed),
		};
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
	const operations = {
		"dom.exists": (selector) => Boolean(selectTarget(selector)),
		"dom.count": (selector) => selectTargets(selector).length,
		"dom.queryText": (selector) => {
			const target = selectTarget(selector);
			return readText(target);
		},
		"dom.queryHtml": (selector) => {
			const target = selectTarget(selector);
			return readHtml(target);
		},
		"dom.queryOuterHtml": (selector) => {
			const target = selectTarget(selector);
			return readOuterHtml(target);
		},
		"dom.queryAttr": (selector, attribute) => {
			const target = selectTarget(selector);
			return readAttribute(target, attribute);
		},
		"dom.queryProperty": (selector, property) => {
			const target = selectTarget(selector);
			return readProperty(target, property);
		},
		"dom.queryRect": (selector) => {
			const target = selectTarget(selector);
			return readRect(target);
		},
		"dom.queryClassList": (selector) => {
			const target = selectTarget(selector);
			return readClassList(target);
		},
		"dom.queryAllText": (selector) =>
			selectTargets(selector).map((target) => readText(target)),
		"dom.queryAllAttr": (selector, attribute) =>
			selectTargets(selector).map((target) => readAttribute(target, attribute)),
		"dom.queryAllProperty": (selector, property) =>
			selectTargets(selector).map((target) => readProperty(target, property)),
		"dom.focus": (selector) => {
			const target = selectTarget(selector);
			if (!target || typeof target.focus !== "function") {
				return false;
			}
			target.focus();
			return true;
		},
		"dom.blur": (selector) => {
			const target = selectTarget(selector);
			if (!target || typeof target.blur !== "function") {
				return false;
			}
			target.blur();
			return true;
		},
		"dom.setValue": (selector, value) => {
			const target = selectTarget(selector);
			if (!target) return false;
			target.value = value;
			return true;
		},
		"dom.setChecked": (selector, checked) => {
			const target = selectTarget(selector);
			if (!target) return false;
			target.checked = checked;
			return true;
		},
		"dom.setSelectedIndex": (selector, selectedIndex) => {
			const target = selectTarget(selector);
			if (!target) return false;
			target.selectedIndex = selectedIndex;
			return true;
		},
		"dom.click": (selector) => {
			const target = selectTarget(selector);
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
			const target = selectTarget(selector);
			if (!target) return false;
			return target.dispatchEvent(buildEvent(spec));
		},
		"page.getTitle": () => String(document.title ?? ""),
		"page.getLocation": () => {
			const result = Object.create(null);
			for (const field of [
				"href",
				"origin",
				"protocol",
				"host",
				"hostname",
				"pathname",
				"search",
				"hash",
			]) {
				result[field] = String(globalThis.location?.[field] ?? "");
			}
			return result;
		},
		"page.getReadyState": () => String(document.readyState ?? ""),
		"page.getVisibility": () => ({
			hidden: Boolean(document.hidden),
			visibilityState: String(document.visibilityState ?? ""),
		}),
		"page.getSelectionText": () => readSelectionText(),
		"page.snapshot": (spec) => {
			const runSnapshotQuery = (querySpec) => {
				switch (querySpec.kind) {
					case "text":
						return operations["dom.queryText"](querySpec.selector);
					case "html":
						return operations["dom.queryHtml"](querySpec.selector);
					case "outerHtml":
						return operations["dom.queryOuterHtml"](querySpec.selector);
					case "attr":
						return operations["dom.queryAttr"](
							querySpec.selector,
							querySpec.attribute,
						);
					case "property":
						return operations["dom.queryProperty"](
							querySpec.selector,
							querySpec.property,
						);
					case "exists":
						return operations["dom.exists"](querySpec.selector);
					case "rect":
						return operations["dom.queryRect"](querySpec.selector);
					case "classList":
						return operations["dom.queryClassList"](querySpec.selector);
					case "allText":
						return operations["dom.queryAllText"](querySpec.selector);
					case "allAttr":
						return operations["dom.queryAllAttr"](
							querySpec.selector,
							querySpec.attribute,
						);
					case "allProperty":
						return operations["dom.queryAllProperty"](
							querySpec.selector,
							querySpec.property,
						);
					case "count":
						return operations["dom.count"](querySpec.selector);
					default:
						throw new Error("Unsupported page.snapshot query kind");
				}
			};
			const result = Object.create(null);
			if (spec.title === true) {
				result.title = String(document.title ?? "");
			}
			if (Array.isArray(spec.location)) {
				const locationResult = Object.create(null);
				for (const field of spec.location) {
					locationResult[field] = String(globalThis.location?.[field] ?? "");
				}
				result.location = locationResult;
			}
			if (spec.readyState === true) {
				result.readyState = String(document.readyState ?? "");
			}
			if (spec.visibility === true) {
				result.visibility = {
					hidden: Boolean(document.hidden),
					visibilityState: String(document.visibilityState ?? ""),
				};
			}
			if (spec.selectionText === true) {
				result.selectionText = readSelectionText();
			}
			if (spec.queries && typeof spec.queries === "object") {
				const queryResults = Object.create(null);
				for (const [key, querySpec] of Object.entries(spec.queries)) {
					queryResults[key] = runSnapshotQuery(querySpec);
				}
				result.queries = queryResults;
			}
			return result;
		},
	};
	try {
		const action = operations[operation];
		if (typeof action !== "function") {
			throw new Error("Unsupported page operation");
		}
		return success(action(...args));
	} catch (error) {
		return fail(error);
	}
}

async function executePageTaskInMainWorld(task, sender) {
	const normalizedTask = normalizeBackgroundPageTask(task);
	const tabId = sender?.tab?.id;
	const frameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
	if (!Number.isInteger(tabId)) {
		throw new Error("Missing tab id for page task");
	}
	if (typeof browser?.scripting?.executeScript !== "function") {
		throw new Error("Page task transport is not available");
	}
	const config = createBackgroundPageTaskConfig(
		normalizedTask.maxResultBytes,
		normalizedTask.oversizedResultMessage,
	);
	let injectionResults;
	try {
		injectionResults = await browser.scripting.executeScript({
			target: {
				tabId,
				frameIds: [frameId],
			},
			world: "MAIN",
			func: executeMainWorldPageCallTask,
			args: [
				normalizedTask.operation,
				normalizedTask.args,
				config,
			],
		});
	} catch (error) {
		throw new Error(
			formatBackgroundPageTaskError(error, "Page task transport failed"),
		);
	}
	const [injectionResult] = Array.isArray(injectionResults) ? injectionResults : [];
	if (!backgroundIsPlainObject(injectionResult)) {
		throw new Error("Page task transport returned an invalid result");
	}
	if (Object.prototype.hasOwnProperty.call(injectionResult, "error")) {
		return {
			transport: "scripting.executeScript",
			ok: false,
			error: formatBackgroundPageTaskError(
				injectionResult.error,
				"Page task failed",
			),
		};
	}
	const result = injectionResult.result;
	if (!backgroundIsPlainObject(result) || typeof result.ok !== "boolean") {
		throw new Error("Page task transport returned an invalid payload");
	}
	if (result.ok !== true) {
		return {
			transport: "scripting.executeScript",
			ok: false,
			error:
				typeof result.error === "string" && result.error
					? result.error
					: "Page task failed",
		};
	}
	const resultJson = JSON.stringify(result.value);
	if (backgroundByteLength(resultJson) > normalizedTask.maxResultBytes) {
		return {
			transport: "scripting.executeScript",
			ok: false,
			error: normalizedTask.oversizedResultMessage,
		};
	}
	return {
		transport: "scripting.executeScript",
		ok: true,
		value: result.value,
	};
}

function sanitizeBackgroundXhrHeaders(input) {
	const headers = {};
	if (input == null) return headers;
	if (typeof input !== "object" || Array.isArray(input)) {
		throw new Error("Invalid XHR headers");
	}
	let headerCount = 0;
	for (const [rawName, rawValue] of Object.entries(input)) {
		const name = String(rawName || "").trim().toLowerCase();
		if (!name) continue;
		if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
			throw new Error("Invalid XHR header name");
		}
		if (
			BACKGROUND_XHR_FORBIDDEN_HEADERS.has(name) ||
			BACKGROUND_XHR_FORBIDDEN_HEADER_PREFIXES.some((prefix) =>
				name.startsWith(prefix),
			)
		) {
			throw new Error(`Forbidden XHR header: ${name}`);
		}
		const value = String(rawValue);
		if (
			value.length > BACKGROUND_XHR_MAX_HEADER_VALUE_LENGTH ||
			/[\r\n]/.test(value)
		) {
			throw new Error("Invalid XHR header value");
		}
		headerCount += 1;
		if (headerCount > BACKGROUND_XHR_MAX_HEADER_COUNT) {
			throw new Error("Too many XHR headers");
		}
		headers[name] = value;
	}
	return headers;
}

function sanitizeBackgroundHandlerFlags(input, allowedHandlers) {
	const handlers = {};
	if (input == null) return handlers;
	if (typeof input !== "object" || Array.isArray(input)) {
		throw new Error("Invalid XHR handler map");
	}
	for (const [key, value] of Object.entries(input)) {
		if (allowedHandlers.has(key) && Boolean(value)) {
			handlers[key] = true;
		}
	}
	return handlers;
}

function validateBackgroundXhrDetails(details) {
	if (details == null || typeof details !== "object" || Array.isArray(details)) {
		throw new Error("Invalid XHR details");
	}
	const method = String(details.method || "GET").toUpperCase();
	if (!BACKGROUND_XHR_ALLOWED_METHODS.has(method)) {
		throw new Error("Unsupported XHR method");
	}
	const url = new URL(String(details.url || ""));
	if (!["http:", "https:"].includes(url.protocol)) {
		throw new Error("Unsupported XHR URL protocol");
	}
	const responseType =
		typeof details.responseType === "string" &&
		BACKGROUND_XHR_ALLOWED_RESPONSE_TYPES.has(details.responseType)
			? details.responseType
			: "";
	const timeout = Number(details.timeout);
	return {
		...details,
		headers: sanitizeBackgroundXhrHeaders(details.headers),
		hasHandlers: sanitizeBackgroundHandlerFlags(
			details.hasHandlers,
			BACKGROUND_XHR_HANDLER_NAMES,
		),
		hasUploadHandlers: sanitizeBackgroundHandlerFlags(
			details.hasUploadHandlers,
			BACKGROUND_XHR_UPLOAD_HANDLER_NAMES,
		),
		method,
		overrideMimeType:
			typeof details.overrideMimeType === "string" ? details.overrideMimeType : "",
		password: typeof details.password === "string" ? details.password : "",
		responseType,
		timeout:
			Number.isFinite(timeout) && timeout > 0
				? Math.min(Math.floor(timeout), BACKGROUND_XHR_MAX_TIMEOUT_MS)
				: 0,
		url: url.href,
		user: typeof details.user === "string" ? details.user : "",
	};
}

function getBackgroundXhrResponseSize(response) {
	if (response == null) return 0;
	if (response instanceof ArrayBuffer) {
		return response.byteLength;
	}
	if (typeof response === "string") {
		return backgroundByteLength(response);
	}
	return 0;
}

function createBackgroundXhrErrorResponse(xhr, responseType, statusText) {
	return {
		contentType:
			xhr.readyState >= xhr.HEADERS_RECEIVED
				? xhr.getResponseHeader("Content-Type")
				: undefined,
		readyState: xhr.readyState,
		response: null,
		responseHeaders:
			xhr.readyState >= xhr.HEADERS_RECEIVED ? xhr.getAllResponseHeaders() : "",
		responseType,
		responseURL: xhr.responseURL,
		status: xhr.status,
		statusText,
		timeout: xhr.timeout,
	};
}

// first sorts files by run-at value, then by weight value
function userscriptSort(a, b) {
	// map the run-at values to numeric values
	const runAtValues = {
		"document-start": 1,
		"document-end": 2,
		"document-idle": 3,
	};
	const runAtA = a.scriptObject["run-at"];
	const runAtB = b.scriptObject["run-at"];
	if (runAtA !== runAtB && runAtValues[runAtA] && runAtValues[runAtB]) {
		return runAtValues[runAtA] > runAtValues[runAtB];
	}
	return Number(a.scriptObject.weight) < Number(b.scriptObject.weight);
}

async function getPlatform() {
	let platform = localStorage.getItem("platform");
	if (!platform) {
		const message = { name: "REQ_PLATFORM" };
		const response = await sendNativeMessage(message);
		if (!response.platform) {
			console.error("Failed to get platform");
			return "";
		}
		platform = response.platform;
		localStorage.setItem("platform", platform);
	}
	return platform;
}

function setClipboard(data, type = "text/plain") {
	// future enhancement?
	// https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write
	// https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText
	const onCopy = (e) => {
		e.stopImmediatePropagation();
		e.preventDefault();
		e.clipboardData.setData(type, data);
		document.removeEventListener("copy", onCopy, true);
	};

	const textarea = document.createElement("textarea");
	textarea.textContent = "<empty clipboard>";
	document.body.appendChild(textarea);
	textarea.select();
	document.addEventListener("copy", onCopy, true);
	try {
		return document.execCommand("copy");
	} catch (error) {
		console.warn("setClipboard failed", error);
		document.removeEventListener("copy", onCopy, true);
		return false;
	} finally {
		document.body.removeChild(textarea);
	}
}

async function setBadgeCount() {
	const clearBadge = () => browser.browserAction.setBadgeText({ text: null });
	// @todo until better introduce in ios, only set badge on macOS
	// set a text badge or an empty string in visionOS will cause the extension's icon to no longer be displayed
	const platform = await getPlatform();
	if (platform !== "macos") return clearBadge();
	// @todo settingsStorage.get("global_exclude_match")
	const settings = await settingsStorage.get([
		"global_active",
		"toolbar_badge_count",
	]);
	if (settings["global_active"] === false) return clearBadge();
	if (settings["toolbar_badge_count"] === false) return clearBadge();

	const currentTab = await browser.tabs.getCurrent();
	// no active tabs exist (user closed all windows)
	if (!currentTab) return clearBadge();
	const url = currentTab.url;
	// if url doesn't exist, stop
	if (!url) return clearBadge();
	// only check for http/s pages
	if (!url.startsWith("http://") && !url.startsWith("https://"))
		return clearBadge();
	// @todo if url match in global exclude list, clear badge
	const frameUrls = new Set();
	const frames = await browser.webNavigation.getAllFrames({
		tabId: currentTab.id,
	});
	for (let i = 0; i < frames.length; i++) {
		const frameUrl = frames[i].url;
		if (frameUrl !== url && frameUrl.startsWith("http")) {
			frameUrls.add(frameUrl);
		}
	}
	const message = {
		name: "POPUP_BADGE_COUNT",
		url,
		frameUrls: Array.from(frameUrls),
	};
	const response = await sendNativeMessage(message);
	if (response?.error) return console.error(response.error);
	if (response?.count > 0) {
		browser.browserAction.setBadgeText({ text: response.count.toString() });
	} else {
		const _url = new URL(url);
		if (_url.pathname.endsWith(".user.js")) {
			browser.browserAction.setBadgeText({ text: "JS" });
		} else {
			clearBadge();
		}
	}
}

// on startup set declarativeNetRequest rulesets
// should also check and refresh when:
// 1. dnr item save event in the page occurs
// 2. dnr item toggle event in the page occurs
// 3. external editor changes script file content
async function setDNRRulesets() {
	if (!browser.declarativeNetRequest.updateDynamicRules) return;
	const message = { name: "REQ_REQUESTS" };
	const response = await sendNativeMessage(message);
	if (response.error) {
		console.error(response.error);
		return;
	}
	// loop through response, parse the rules, push to array and log
	/** @type {import("webextension-polyfill").DeclarativeNetRequest.Rule[]} */
	const addRules = [];
	let ruleId = 1;
	for (let i = 0; i < response.length; i++) {
		if (
			ruleId >
			browser.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES
		) {
			console.warn(
				"Rules exceed the maximum number, some rules will be ignored",
			);
			break;
		}
		const ruleset = response[i];
		/** @type {Array} */
		let rules;
		try {
			const res = JSON.parse(ruleset.code);
			// check if an array or single rule
			if (Array.isArray(res)) {
				rules = res;
			} else if (typeof res === "object") {
				rules = [res];
			} else {
				console.warn(`Not a valid DNR ruleset: ${ruleset.name}`);
				continue;
			}
			console.info(`Setting DNR ruleset: ${ruleset.name} (${rules.length})`);
		} catch (error) {
			console.warn(
				`Failed parsed into a valid DNR ruleset: ${ruleset.name}`,
				error,
			);
			continue;
		}
		for (const rule of rules) {
			// simple check if it is a rule object
			if (!rule.action || !rule.condition || !rule.id) {
				console.warn("Not a valid DNR rule:", rule);
				continue;
			}
			// set unique ids for all rules to ensure no repeats
			rule.id = ruleId++;
			addRules.push(rule);
		}
	}
	// remove all then add declarativeNetRequest rules
	try {
		const oldRules = await browser.declarativeNetRequest.getDynamicRules();
		const removeRuleIds = oldRules.map((rule) => rule.id);
		await browser.declarativeNetRequest.updateDynamicRules({
			addRules,
			removeRuleIds,
		});
	} catch (error) {
		return console.error(error);
	}
	console.info(`Finished setting ${addRules.length} DNR rules`);
}

// the current update logic is similar to setDNRRulesets()
// this feature needs a more detailed redesign in the future
// https://github.com/quoid/userscripts/issues/453
async function getContextMenuItems() {
	// macos exclusive feature
	const platform = await getPlatform();
	if (platform !== "macos") return;
	// since it's not possible to get a list of currently active menu items
	// on update, all context-menu items are cleared, then re-added
	// this is done to ensure fresh code changes appear
	await browser.menus.removeAll();
	// get the context-menu scripts
	const message = { name: "REQ_CONTEXT_MENU_SCRIPTS" };
	const response = await sendNativeMessage(message);
	if (response.error) {
		console.error(response.error);
		return;
	}
	// add menus items
	const items = response.files?.menu || [];
	if (items.length) {
		console.info(`Setting ${items.length} context-menu userscripts`);
	}
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		// context-menu scripts require @match value
		// @include values are ignored
		if (!item.scriptObject.matches.length) continue;
		addContextMenuItem(item);
	}
}

async function addContextMenuItem(userscript) {
	const patterns = userscript.scriptObject.matches;
	browser.menus.create(
		{
			contexts: ["all"],
			documentUrlPatterns: patterns,
			id: userscript.scriptObject.filename,
			title: userscript.scriptObject.name,
		},
		() => {
			// add event listener if needed
			if (!browser.menus.onClicked.hasListener(contextClick)) {
				browser.menus.onClicked.addListener(contextClick);
			}
		},
	);
}

async function contextClick(info, tab) {
	// when any created context-menu item is clicked, send message to tab
	// the content script for that tag will have the context-menu code
	// which will get send back in the response if/when found
	const message = { name: "CONTEXT_RUN", menuItemId: info.menuItemId };
	const response = await browser.tabs.sendMessage(tab.id, message);
	// if code is returned, execute on that tab
	if (!response.code) return;
	browser.tabs.executeScript(tab.id, { code: response.code });
}

async function nativeChecks() {
	const response = await sendNativeMessage({
		name: "NATIVE_CHECKS",
	});
	if (response.error) {
		settingsStorage.set({ error_native: response });
		return false;
	}
	settingsStorage.reset("error_native");
	return true;
}

/**
 * Handles messages sent with `browser.runtime.sendMessage`
 * Make sure not to return `undefined` or `rejection`, otherwise the reply may never be delivered
 * @see {@link https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage#listener}
 * @type {Parameters<typeof browser.runtime.onMessage.addListener>[0]}
 * @returns {Promise<{status: "pending"|"fulfilled"|"rejected", result?: any}>}
 */
async function handleMessage(message, sender) {
	switch (message.name) {
		case "REQ_USERSCRIPTS": {
			// get the page url from the content script that sent request
			const url = sender.url;
			// use frameId to determine if request came from top level window
			// if @noframes true, and isTop false, swift layer won't return code
			const isTop = sender.frameId === 0;
			// send request to swift layer to provide code for page url
			const message = { name: "REQ_USERSCRIPTS", url, isTop };
			try {
				const response = await sendNativeMessage(message);
				if (import.meta.env.MODE === "development") {
					console.debug("REQ_USERSCRIPTS", message, response);
				}
				// if request failed, send error to content script for logging
				if (response.error) return response;
				// sort files
				response.files.js.sort(userscriptSort);
				response.files.css.sort((a, b) => Number(a.weight) < Number(b.weight));
				// return sorted files for injection
				return response;
			} catch (error) {
				console.error(error);
				// @ts-ignore -- ignore for now and will reconstruct this in the future.
				return { error: String(error) };
			}
		}
		case "API_CLOSE_TAB": {
			try {
				await browser.tabs.remove(message.tabId || sender.tab.id);
				return { status: "fulfilled" };
			} catch (error) {
				console.error(message, sender, error);
				return { status: "rejected", result: String(error) };
			}
		}
		case "API_OPEN_TAB": {
			try {
				const tab = await browser.tabs.create({
					active: message.active,
					index: sender.tab.index + 1,
					url: message.url,
				});
				return { status: "fulfilled", result: tab };
			} catch (error) {
				console.error(message, sender, error);
				return { status: "rejected", result: String(error) };
			}
		}
		case "API_ADD_STYLE": {
			try {
				await browser.tabs.insertCSS(sender.tab.id, {
					code: message.css,
					cssOrigin: "user",
				});
				return { status: "fulfilled" };
			} catch (error) {
				console.error(message, sender, error);
				return { status: "rejected", result: String(error) };
			}
		}
		case "API_GET_TAB": {
			if (typeof sender.tab === "undefined") {
				const error = "unable to deliver tab due to empty tab id";
				return { status: "rejected", result: error };
			}
			try {
				const tabData = sessionStorage.getItem(`tab-${sender.tab.id}`);
				// if tabData is null, can still parse it and return that
				const tabObj = JSON.parse(tabData);
				return { status: "fulfilled", result: tabObj };
			} catch (error) {
				console.error("failed to parse tab data for getTab", error);
				return { status: "rejected", result: String(error) };
			}
		}
		case "API_SAVE_TAB": {
			if (sender.tab != null && sender.tab.id) {
				const key = `tab-${sender.tab.id}`;
				sessionStorage.setItem(key, JSON.stringify(message.tabObj));
				return { status: "fulfilled" };
			} else {
				const error = "unable to save tab, empty tab id";
				return { status: "rejected", result: String(error) };
			}
		}
		case "API_SET_CLIPBOARD": {
			const result = setClipboard(message.clipboardData, message.type);
			return { status: "fulfilled", result };
		}
		case "API_PAGE_EXECUTE": {
			try {
				const result = await executePageTaskInMainWorld(message.task, sender);
				return { status: "fulfilled", result };
			} catch (error) {
				console.error(error);
				return {
					status: "rejected",
					result: {
						message: String(error?.message || error),
					},
				};
			}
		}
		case "API_XHR": {
			try {
				// initializing an xhr instance
				const xhr = new XMLHttpRequest();
				// establish a long-lived port connection to content script
				/** @type {import("../global.d.ts").TypeBackground.XHRPort} */
				const port = browser.tabs.connect(sender.tab.id, {
					name: message.xhrPortName,
				});
				// receive messages from content script and process them
				port.onMessage.addListener((msg) => {
					if (msg.name === "ABORT") xhr.abort();
					if (msg.name === "DISCONNECT") port.disconnect();
				});
				// handle port disconnect and clean tasks
				port.onDisconnect.addListener((p) => {
					if (p?.error) {
						console.error(
							`port disconnected due to an error: ${p.error.message}`,
						);
					}
				});
				// parse details and set up for xhr instance
				/** @type {TypeExtMessages.XHRTransportableDetails} */
				const details = validateBackgroundXhrDetails(message.details);
				/** @type {Parameters<XMLHttpRequest["open"]>[0]} */
				const method = details.method || "GET";
				/** @type {Parameters<XMLHttpRequest["open"]>[1]} */
				const url = details.url;
				/** @type {Parameters<XMLHttpRequest["open"]>[3]} */
				const user = details.user || null;
				/** @type {Parameters<XMLHttpRequest["open"]>[4]} */
				const password = details.password || null;
				/** @type {Parameters<XMLHttpRequest["send"]>[0]} */
				let body = null;
				if (typeof details.data === "object") {
					/** @type {TypeExtMessages.XHRProcessedData} */
					const data = details.data;
					if (typeof data.data === "string") {
						if (data.type === "Text") {
							// deprecate once body supports more data types
							// the `binary` key will no longer needed
							if (details.binary) {
								const binaryString = data.data;
								const view = new Uint8Array(binaryString.length);
								for (let i = 0; i < binaryString.length; i++) {
									view[i] = binaryString.charCodeAt(i);
								}
								body = view;
							} else {
								body = data.data;
							}
						}
						if (data.type === "Document") {
							body = data.data;
							if (!("content-type" in details.headers)) {
								details.headers["content-type"] = data.mime;
							}
						}
						if (data.type === "URLSearchParams") {
							body = new URLSearchParams(data.data);
						}
					}
					if (Array.isArray(data.data)) {
						if (
							data.type === "ArrayBuffer" ||
							data.type === "ArrayBufferView"
						) {
							body = new Uint8Array(data.data);
						}
						if (data.type === "Blob") {
							body = new Uint8Array(data.data);
							if (!("content-type" in details.headers)) {
								details.headers["content-type"] = data.mime;
							}
						}
						if (data.type === "FormData") {
							body = new FormData();
							for (const [k, v] of data.data) {
								if (typeof v === "string") {
									body.append(k, v);
								} else {
									const view = new Uint8Array(v.data);
									body.append(
										k,
										new File([view], v.name, {
											type: v.mime,
											lastModified: v.lastModified,
										}),
									);
								}
							}
						}
					}
				}
				// xhr instances automatically filter out unexpected user values
				xhr.timeout = details.timeout;
				xhr.responseType = details.responseType;
				// record parsed values for subsequent use
				const responseType = xhr.responseType;
				const handlers = details.hasHandlers ?? {};
				let responseLimitTriggered = false;
				const failOversizedResponse = (reason) => {
					if (responseLimitTriggered) return true;
					responseLimitTriggered = true;
					const errorResponse = createBackgroundXhrErrorResponse(
						xhr,
						responseType,
						reason,
					);
					if (handlers.onerror) {
						port.postMessage({ handler: "onerror", response: errorResponse });
					}
					if (handlers.onloadend) {
						port.postMessage({ handler: "onloadend", response: errorResponse });
					} else {
						port.postMessage({ handler: "onloadend" });
					}
					try {
						xhr.abort();
					} catch {
						// Ignore abort failures when the request is already closing.
					}
					return true;
				};
				// avoid unexpected behavior of legacy defaults such as parsing XML
				if (responseType === "") xhr.responseType = "text";
				// transfer to content script via arraybuffer and then parse to blob
				if (responseType === "blob") xhr.responseType = "arraybuffer";
				// transfer to content script via text and then parse to document
				if (responseType === "document") xhr.responseType = "text";
				xhr.addEventListener("readystatechange", () => {
					if (responseLimitTriggered || xhr.readyState < xhr.HEADERS_RECEIVED) {
						return;
					}
					const contentLength = Number(xhr.getResponseHeader("Content-Length"));
					if (
						Number.isFinite(contentLength) &&
						contentLength > BACKGROUND_XHR_MAX_RESPONSE_BYTES
					) {
						failOversizedResponse("XHR response is too large");
					}
				});
				xhr.addEventListener("progress", (event) => {
					if (responseLimitTriggered) return;
					if (Number(event.loaded) > BACKGROUND_XHR_MAX_RESPONSE_BYTES) {
						failOversizedResponse("XHR response is too large");
					}
				});
				// add required listeners and send result back to the content script
				if (details.hasUploadHandlers) {
					for (const handler of Object.keys(details.hasUploadHandlers)) {
						/** @param {ProgressEvent} event */
						xhr.upload[handler] = async (event) => {
							/** @type {TypeExtMessages.XHRProgress} */
							const progress = {
								lengthComputable: event.lengthComputable,
								loaded: event.loaded,
								total: event.total,
							};
							port.postMessage({ handler, progress });
						};
					}
				}
				for (const handler of Object.keys(handlers)) {
					xhr[handler] = async () => {
						if (responseLimitTriggered) return;
						// can not send xhr through postMessage
						// construct new object to be sent as "response"
						/** @type {TypeExtMessages.XHRTransportableResponse} */
						const response = {
							contentType: undefined, // non-standard
							readyState: xhr.readyState,
							response: xhr.response,
							responseHeaders: xhr.getAllResponseHeaders(),
							responseType,
							responseURL: xhr.responseURL,
							status: xhr.status,
							statusText: xhr.statusText,
							timeout: xhr.timeout,
						};
						// https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/response#value
						if (xhr.readyState < xhr.DONE && xhr.responseType !== "text") {
							response.response = null;
						}
						// get content-type when headers received
						if (xhr.readyState >= xhr.HEADERS_RECEIVED) {
							response.contentType = xhr.getResponseHeader("Content-Type");
						}
						// only process when xhr is complete and data exist
						// note the status of the last `progress` event in Safari is DONE/4
						// exclude this event to avoid unnecessary processing and transmission
						if (
							xhr.readyState === xhr.DONE &&
							xhr.response !== null &&
							handler !== "onprogress"
						) {
							if (
								getBackgroundXhrResponseSize(xhr.response) >
								BACKGROUND_XHR_MAX_RESPONSE_BYTES
							) {
								failOversizedResponse("XHR response is too large");
								return;
							}
							// need to convert arraybuffer data to postMessage
							if (
								xhr.responseType === "arraybuffer" &&
								xhr.response instanceof ArrayBuffer
							) {
								const buffer = xhr.response;
								response.response = Array.from(new Uint8Array(buffer));
							}
						}
						port.postMessage({ handler, response });
					};
				}
				// if onloadend not set in xhr details
				// onloadend event won't be passed to content script
				// if that happens port DISCONNECT message won't be posted
				// so if details lacks onloadend then attach the listener
				if (!handlers.onloadend) {
					xhr.onloadend = () => {
						port.postMessage({ handler: "onloadend" });
					};
				}
				if (details.overrideMimeType) {
					xhr.overrideMimeType(details.overrideMimeType);
				}
				xhr.open(method, url, true, user, password);
				// must set headers after `xhr.open()`, but before `xhr.send()`
				if (typeof details.headers === "object") {
					for (const [key, val] of Object.entries(details.headers)) {
						xhr.setRequestHeader(key, val);
					}
				}
				xhr.send(body);
				return { status: "fulfilled" };
			} catch (error) {
				console.error(error);
				return { status: "rejected", result: String(error) };
			}
		}
		case "REFRESH_DNR_RULES": {
			setDNRRulesets();
			break;
		}
		case "REFRESH_CONTEXT_MENU_SCRIPTS": {
			getContextMenuItems();
			break;
		}
		case "WEB_USERJS_POPUP": {
			const currentTab = await browser.tabs.getCurrent();
			if (currentTab.id === sender.tab.id) {
				browser.browserAction.openPopup();
			}
			break;
		}
	}
}
browser.runtime.onInstalled.addListener(async () => {
	await nativeChecks();
	const enable = await settingsStorage.get("augmented_userjs_install");
	await contentScriptRegistration(enable);
});
browser.runtime.onStartup.addListener(async () => {
	setDNRRulesets();
	getContextMenuItems();
});
// listens for messages from content script, popup and page
browser.runtime.onMessage.addListener(handleMessage);
// set the badge count
browser.tabs.onActivated.addListener(setBadgeCount);
browser.windows.onFocusChanged.addListener(async (windowId) => {
	if (windowId < 1) {
		// lose focus
		return;
	}
	nativeChecks();
	setBadgeCount();
	setDNRRulesets();
	getContextMenuItems();
});
browser.webNavigation.onCompleted.addListener(setBadgeCount);

// handle native app messages
const port = connectNative();
port.onMessage.addListener(async (message) => {
	// console.info(message); // DEBUG
	if (message.name === "SAVE_LOCATION_CHANGED") {
		await openExtensionPage();
		if (message?.userInfo?.returnApp === true) {
			sendNativeMessage({ name: "OPEN_APP" });
		}
	}
	// if (message.name === "OPEN_EXTENSION_PAGE") {
	// 	openExtensionPage();
	// }
});
