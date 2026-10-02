/**
 * 脚本运行前在 QuickJS VM 里求值的前置源码（迁移 pi packages/codemode/src/runtime/prelude-source.ts）。
 *
 * VM 是独立 wasm 实例，这里不做跨 realm 边界防护，只做两件事：
 *   1) 把宿主桥（bridge）收进闭包——脚本无法直接拿到它，唯一出口是 tools.<name>() / 全局函数；
 *   2) 在桥之上搭出 tools / ALL_TOOLS / text / image / exit / console / store / load。
 * 工具参数与结果都以 JSON 字符串穿越边界，在本侧解析——变量不做结构化克隆。
 *
 * 求值结果是一个函数 `(bridge, toolsJson, globalsJson, storeJson) => { settle, run, stalled }`。
 * `stalled()` 报告「既没跑完、又没有在途工具调用」的脚本：VM 里没有定时器与 IO，
 * 这种脚本永远等不到人唤醒，与其挂到超时不如立刻判失败。
 */
export const MAX_STORE_VALUE_CHARS = 256 * 1024;
export const MAX_STORE_TOTAL_CHARS = 1024 * 1024;

const IMAGE_HELPER_EXPECTS = 'image 只接受非空图片 URL 字符串、带 image_url 的对象，或原始 MCP image block';

export const PRELUDE_SOURCE = `(function (bridge, toolsJson, globalsJson, storeJson) {
	"use strict";
	const stringify = JSON.stringify;
	const parse = JSON.parse;
	const promiseThen = Promise.prototype.then;
	const ErrorCtor = Error;
	const TypeErrorCtor = TypeError;
	const pending = new Map();
	let nextId = 1;
	let finished = false;
	// exit() 在已经上报成功之后用它把脚本摊开
	const EXIT = Object.freeze({});

	function done(ok, payload, writes) {
		if (finished) return;
		finished = true;
		bridge("done", ok, payload, writes);
	}

	function serialize(value) {
		return value === undefined ? undefined : stringify(value);
	}

	// QuickJS 的堆栈只有帧列表。补上 "Name: message" 前缀读起来才与 Node 报错一致，
	// 并丢掉前置源码自己的帧（codemode-prelude.js）
	function errorText(error) {
		const head = error.message ? error.name + ": " + error.message : String(error.name);
		const frames =
			typeof error.stack === "string"
				? error.stack.split("\\n").filter((line) => line.trim() && !line.includes("codemode-prelude.js"))
				: [];
		return [head, ...frames].join("\\n");
	}

	function format(value) {
		if (typeof value === "string") return value;
		if (value instanceof ErrorCtor) return errorText(value);
		try {
			const json = stringify(value);
			return json === undefined ? String(value) : json;
		} catch {
			return String(value);
		}
	}

	function describeError(error) {
		if (error instanceof ErrorCtor) {
			return stringify({ name: error.name, message: error.message, stack: errorText(error) });
		}
		return stringify({ message: format(error) });
	}

	function caller(kind, name, spread) {
		return (...args) =>
			new Promise((resolve, reject) => {
				let json;
				try {
					json = serialize(spread ? args : args[0]);
				} catch (error) {
					reject(error);
					return;
				}
				const id = nextId++;
				pending.set(id, { resolve, reject });
				bridge(kind, id, name, json);
			});
	}

	const tools = Object.create(null);
	const allTools = [];
	for (const { name, jsName, description } of parse(toolsJson)) {
		const fn = caller("call", name);
		// 两个工具名归一成同一标识符时先注册者赢
		if (!(jsName in tools)) {
			tools[jsName] = fn;
			allTools.push(Object.freeze({ name: jsName, description }));
		}
		if (!(name in tools)) tools[name] = fn;
	}
	Object.freeze(tools);
	Object.freeze(allTools);

	const namespaces = new Map();
	for (const { name, spread } of parse(globalsJson)) {
		const fn = caller("global", name, spread);
		const dot = name.indexOf(".");
		if (dot === -1) {
			Object.defineProperty(globalThis, name, { value: fn, enumerable: true });
			continue;
		}
		const namespace = name.slice(0, dot);
		if (!namespaces.has(namespace)) namespaces.set(namespace, Object.create(null));
		namespaces.get(namespace)[name.slice(dot + 1)] = fn;
	}
	for (const [namespace, members] of namespaces) {
		Object.defineProperty(globalThis, namespace, { value: Object.freeze(members), enumerable: true });
	}

	// key -> JSON 文本。体积按 key 与 JSON 字符数计
	const stored = new Map(Object.entries(parse(storeJson)));
	const writes = new Map();
	let storedChars = 0;
	for (const [key, json] of stored) storedChars += key.length + json.length;

	function checkKey(name, key) {
		if (typeof key !== "string") throw new TypeError(name + "() 的 key 必须是字符串");
	}

	function store(key, value) {
		checkKey("store", key);
		const previous = stored.has(key) ? key.length + stored.get(key).length : 0;
		if (value === undefined) {
			stored.delete(key);
			storedChars -= previous;
			writes.set(key, undefined);
			return;
		}
		let json;
		try {
			json = stringify(value);
		} catch (error) {
			throw new TypeError("store(" + stringify(key) + ") 的值无法 JSON 序列化: " + format(error));
		}
		if (json === undefined) {
			throw new TypeError("store(" + stringify(key) + ") 的值无法 JSON 序列化");
		}
		if (json.length > ${MAX_STORE_VALUE_CHARS}) {
			throw new RangeError("store(" + stringify(key) + ") 的值超过 ${MAX_STORE_VALUE_CHARS} 字符的 JSON");
		}
		const next = storedChars - previous + key.length + json.length;
		if (next > ${MAX_STORE_TOTAL_CHARS}) {
			throw new RangeError("store 已满：全部存量会超过 ${MAX_STORE_TOTAL_CHARS} 字符的 JSON");
		}
		stored.set(key, json);
		storedChars = next;
		writes.set(key, json);
	}

	function load(key) {
		checkKey("load", key);
		const json = stored.get(key);
		return json === undefined ? undefined : parse(json);
	}

	function serializeWrites() {
		const entries = [];
		for (const [key, json] of writes) entries.push(json === undefined ? [key] : [key, json]);
		return stringify(entries);
	}

	Object.defineProperty(globalThis, "store", { value: store, enumerable: true });
	Object.defineProperty(globalThis, "load", { value: load, enumerable: true });

	// 原始值走字符串形式，其余走 JSON
	function outputText(value) {
		if (value === undefined || value === null || (typeof value !== "object" && typeof value !== "function")) {
			return String(value);
		}
		const json = stringify(value);
		return json === undefined ? String(value) : json;
	}

	function text(value) {
		let rendered;
		try {
			rendered = outputText(value);
		} catch (error) {
			throw new TypeErrorCtor(error instanceof ErrorCtor ? error.message : String(error));
		}
		if (!finished) bridge("output", "text", rendered);
	}

	function imageUrl(value) {
		if (typeof value === "string") return value;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		}
		if (value.image_url !== undefined) {
			if (typeof value.image_url !== "string") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
			return value.image_url;
		}
		if (typeof value.type !== "string") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		if (value.type !== "image") {
			throw new TypeErrorCtor('image 只接受 MCP image block，收到了 "' + value.type + '"');
		}
		if (typeof value.data !== "string" || value.data === "") throw new TypeErrorCtor("image 需要 MCP image data");
		if (value.data.toLowerCase().startsWith("data:")) return value.data;
		return "data:;base64," + value.data;
	}

	// 各家接受的内联图片格式签名（PNG、JPEG 除 JPEG-LS、GIF、"RIFF....WEBP"）。
	// 签名都在第 0 字节起，因此编码就是前缀
	const IMAGE_SIGNATURES = [
		["image/png", /^iVBORw0KGg/],
		["image/jpeg", /^[/]9j[/](?!9)/],
		["image/gif", /^R0lGOD[dl]h/],
		["image/webp", /^UklG.{8}RUJQ/],
	];

	function image(value) {
		const url = imageUrl(value);
		if (url === "") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		const colon = url.indexOf(":");
		const scheme = colon === -1 ? "" : url.slice(0, colon).toLowerCase();
		if (scheme === "http" || scheme === "https") {
			throw new TypeErrorCtor("工具结果不支持远程图片 URL，请传 base64 data URI");
		}
		const comma = url.indexOf(",");
		const header = comma === -1 ? [] : url.slice(colon + 1, comma).split(";");
		if (scheme !== "data" || comma === -1 || header.slice(1).every((part) => part.toLowerCase() !== "base64")) {
			throw new TypeErrorCtor("图片输出非法，请传 base64 data URI");
		}
		// 上游会因坏图拒掉整个请求，而持久化的 image block 之后每一轮都要重发。
		// 换行造成的 base64 折行一律剥掉；声明类型不可信（上游同样拒类型不匹配），按探测到的算
		const data = url.slice(comma + 1).replace(/\\s+/g, "");
		if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
			throw new TypeErrorCtor("图片输出非法：base64 数据不完整或被破坏");
		}
		const head = data.slice(0, 16);
		const signature = IMAGE_SIGNATURES.find(([, pattern]) => pattern.test(head));
		if (!signature) {
			throw new TypeErrorCtor("图片输出非法：数据不是 PNG / JPEG / GIF / WebP");
		}
		if (!finished) bridge("output", "image", data, signature[0]);
	}

	function exit() {
		let writesJson;
		try {
			writesJson = serializeWrites();
		} catch (error) {
			done(false, describeError(error));
			throw EXIT;
		}
		done(true, undefined, writesJson);
		throw EXIT;
	}

	const console = {};
	for (const level of ["log", "info", "warn", "error", "debug"]) {
		console[level] = (...args) => {
			if (!finished) bridge("output", "text", args.map(format).join(" "));
		};
	}
	Object.freeze(console);

	Object.defineProperty(globalThis, "tools", { value: tools, enumerable: true });
	Object.defineProperty(globalThis, "ALL_TOOLS", { value: allTools, enumerable: true });
	Object.defineProperty(globalThis, "console", { value: console, enumerable: true });
	Object.defineProperty(globalThis, "text", { value: text, enumerable: true });
	Object.defineProperty(globalThis, "image", { value: image, enumerable: true });
	Object.defineProperty(globalThis, "exit", { value: exit, enumerable: true });

	return {
		settle(id, ok, payload) {
			const entry = pending.get(id);
			if (!entry) return;
			pending.delete(id);
			if (!ok) {
				entry.reject(new ErrorCtor(payload));
				return;
			}
			let value;
			try {
				value = payload === undefined ? undefined : parse(payload);
			} catch (error) {
				entry.reject(error);
				return;
			}
			entry.resolve(value);
		},
		run(fn) {
			let promise;
			try {
				promise = fn(tools, console);
			} catch (error) {
				done(false, describeError(error));
				return;
			}
			promiseThen.call(
				promise,
				(value) => {
					let json;
					try {
						json = serialize(value);
					} catch (error) {
						done(false, describeError(error));
						return;
					}
					done(true, json, serializeWrites());
				},
				(error) => {
					done(false, describeError(error));
				},
			);
		},
		stalled() {
			if (finished || pending.size > 0) return false;
			done(
				false,
				stringify({
					name: "Error",
					message:
						"脚本在等一个永远等不到的承诺：没有在途工具调用，而这里没有定时器。",
				}),
			);
			return true;
		},
	};
})`;
