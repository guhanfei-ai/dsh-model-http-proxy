window.__ModuleLoader__.load({
	id: "dsh-model-http-proxy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/hosts.ts
		/**
		* Browser-safe hostname helpers shared by the Host half (routing) and the
		* browser card (suggestions). No node imports, so either bundle can inline
		* this module without dragging in `undici`.
		* @module dsh-model-http-proxy/hosts
		*/
		/** The official DeepSeek adapter's default endpoint host. */
		const DEFAULT_DEEPSEEK_HOST = "api.deepseek.com";
		/**
		* The endpoint each pi-ai catalog route uses when its profile names no
		* `baseURL` of its own. Mirrors `builtinProviders()` of the installed catalog
		* (pi-ai 1.3.0); routes whose endpoint is built per request (Bedrock, Azure,
		* Vertex, the Cloudflare gateways, opencode, typesafe) carry no entry and
		* resolve to nothing here — a configured profile of that kind simply does not
		* contribute a suggestion.
		*
		* The settings page reads this to show the hosts of the providers that are
		* actually configured: a catalog route such as `kimi-coding` names no
		* `baseURL`, so without this table its endpoint would be unknowable in the
		* browser (the catalog itself is a Host-only dependency).
		*/
		const PROVIDER_ENDPOINTS = {
			"ant-ling": "https://api.ant-ling.com/v1",
			anthropic: "https://api.anthropic.com",
			baseten: "https://inference.baseten.co/v1",
			cerebras: "https://api.cerebras.ai/v1",
			deepseek: "https://api.deepseek.com",
			"deepseek-official": "https://api.deepseek.com",
			"deepseek-account": "https://api.deepseek.com",
			fireworks: "https://api.fireworks.ai/inference",
			"github-copilot": "https://api.individual.githubcopilot.com",
			google: "https://generativelanguage.googleapis.com/v1beta",
			groq: "https://api.groq.com/openai/v1",
			huggingface: "https://router.huggingface.co/v1",
			"kimi-coding": "https://api.kimi.com/coding/v1",
			meta: "https://api.meta.ai/v1",
			minimax: "https://api.minimax.io/anthropic",
			"minimax-cn": "https://api.minimaxi.com/anthropic",
			mistral: "https://api.mistral.ai",
			moonshotai: "https://api.moonshot.ai/v1",
			"moonshotai-cn": "https://api.moonshot.cn/v1",
			nvidia: "https://integrate.api.nvidia.com/v1",
			openai: "https://api.openai.com/v1",
			"openai-codex": "https://chatgpt.com/backend-api",
			openrouter: "https://openrouter.ai/api/v1",
			"qwen-token-plan": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
			"qwen-token-plan-cn": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
			"qwen-token-plan-individual": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
			together: "https://api.together.ai/v1",
			"vercel-ai-gateway": "https://ai-gateway.vercel.sh",
			xai: "https://api.x.ai/v1",
			xiaomi: "https://api.xiaomimimo.com/v1",
			"xiaomi-token-plan-ams": "https://token-plan-ams.xiaomimimo.com/v1",
			"xiaomi-token-plan-cn": "https://token-plan-cn.xiaomimimo.com/v1",
			"xiaomi-token-plan-sgp": "https://token-plan-sgp.xiaomimimo.com/v1",
			zai: "https://api.z.ai/api/coding/paas/v4",
			"zai-coding-cn": "https://open.bigmodel.cn/api/coding/paas/v4"
		};
		/**
		* Resolve one configured pi-ai provider profile to the host its requests land
		* on: the profile's own `baseURL` when it sets one (custom gateways such as
		* `azapi` do), else the catalog endpoint of that route, else nothing.
		* @param route - the provider key in the `llm-pi-ai` settings document.
		* @param baseURL - that profile's `baseURL`, if it sets one.
		* @returns the bare lowercase hostname, or undefined when it cannot be known.
		*/
		function providerEndpointHost(route, baseURL) {
			if (typeof baseURL === "string" && baseURL.length > 0) try {
				return hostnameOf(baseURL);
			} catch {
				return;
			}
			const endpoint = PROVIDER_ENDPOINTS[route];
			if (endpoint === void 0) return void 0;
			try {
				return hostnameOf(endpoint);
			} catch {
				return;
			}
		}
		/**
		* Extract the hostname from an absolute URL string or `URL`.
		* @param value - the URL to read.
		* @returns the lowercase hostname.
		*/
		function hostnameOf(value) {
			return value instanceof URL ? value.hostname : new URL(value).hostname;
		}
		/** Count one-character occurrences; enough for the `:` scan below. */
		function countOf(value, needle) {
			let count = 0;
			for (let i = 0; i < value.length; i++) if (value[i] === needle) count++;
			return count;
		}
		/**
		* Normalize a user-entered host entry to the form `shouldProxy` matches
		* against (`new URL(url).hostname`). Accepts a plain hostname, `host:port`,
		* a bracketed or bare IPv6 literal, an absolute URL (scheme, port, and path
		* are all stripped), or a suffix entry (`*.example.com` or `.example.com`,
		* both kept as `.example.com`). Returns undefined when nothing usable
		* remains.
		* @param entry - a raw `proxyHosts` / `excludeHosts` entry.
		* @returns the normalized entry, or undefined for an empty/invalid entry.
		*/
		function normalizeHostEntry(entry) {
			const trimmed = entry.trim();
			if (trimmed.length === 0) return void 0;
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) try {
				return new URL(trimmed).hostname.toLowerCase();
			} catch {
				return;
			}
			const beforePath = trimmed.split("/")[0] ?? "";
			let hostPart;
			if (beforePath.startsWith("[")) {
				const close = beforePath.indexOf("]");
				hostPart = close === -1 ? beforePath : beforePath.slice(0, close + 1);
			} else if (countOf(beforePath, ":") === 1) hostPart = beforePath.split(":")[0] ?? "";
			else hostPart = beforePath;
			let bare = hostPart.toLowerCase();
			if (bare.length === 0) return void 0;
			if (bare.includes(":") && !bare.startsWith("[")) bare = `[${bare}]`;
			if (bare.startsWith("*.")) bare = bare.slice(1);
			if (bare.endsWith(".")) bare = bare.slice(0, -1);
			return bare.length > 0 ? bare : void 0;
		}
		//#endregion
		//#region \0dsh-css:/Users/ttpai/tayGit/dsh-model-http-proxy/src/client/card.module.css.mjs
		const css = ".lzhaKq_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}.lzhaKq_card:hover{border-color:var(--dsw-alias-label-dimmed)}.lzhaKq_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}.lzhaKq_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.lzhaKq_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.lzhaKq_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.lzhaKq_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.lzhaKq_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.lzhaKq_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.lzhaKq_chevronOpen{transform:rotate(180deg)}.lzhaKq_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}.lzhaKq_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}.lzhaKq_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.lzhaKq_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}.lzhaKq_field+.lzhaKq_field{border-top:1px solid var(--dsw-alias-border-l2)}.lzhaKq_head{align-items:center;gap:8px;display:flex}.lzhaKq_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}.lzhaKq_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}.lzhaKq_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.lzhaKq_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.lzhaKq_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}.lzhaKq_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}.lzhaKq_status{min-width:0;color:var(--dsw-alias-label-tertiary);flex:1;margin:0;font-size:12px;line-height:1.5}.lzhaKq_statusSaved{color:var(--dsw-alias-state-success-primary)}.lzhaKq_statusFailed{color:var(--dsw-alias-label-error)}.lzhaKq_combo{position:relative}.lzhaKq_comboBox{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;flex-wrap:wrap;align-items:center;gap:6px;min-height:34px;padding:4px 30px 4px 8px;display:flex}.lzhaKq_comboBox:focus-within{border-color:var(--dsw-alias-brand-primary)}.lzhaKq_comboEntry{min-width:120px;height:24px;font:inherit;color:var(--dsw-alias-label-primary);background:0 0;border:none;outline:none;flex:120px;font-size:13px}.lzhaKq_comboEntry::placeholder{color:var(--dsw-alias-label-tertiary)}.lzhaKq_chip{background:var(--dsw-alias-bg-module-platform);max-width:100%;color:var(--dsw-alias-label-primary);border-radius:6px;align-items:center;gap:4px;padding:2px 4px 2px 8px;font-size:12px;line-height:18px;display:inline-flex}.lzhaKq_chipLabel{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.lzhaKq_chipRemove{width:16px;height:16px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:4px;justify-content:center;align-items:center;padding:0;display:inline-flex}.lzhaKq_chipRemove:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.lzhaKq_chipRemove:disabled{opacity:.5;cursor:default}.lzhaKq_comboChevron{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:0;display:inline-flex;position:absolute;top:50%;right:8px;transform:translateY(-50%)}.lzhaKq_comboChevron svg{transition:transform .16s}.lzhaKq_comboChevronOpen{transform:rotate(180deg)}.lzhaKq_comboChevron:disabled{opacity:.5;cursor:default}.lzhaKq_comboList{z-index:100;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);max-height:240px;box-shadow:var(--dsw-shadow-lv3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex-direction:column;gap:0;margin:0;padding:4px;list-style:none;display:flex;position:absolute;top:calc(100% + 4px);left:0;right:0;overflow-y:auto}.lzhaKq_comboItem{cursor:pointer;width:100%;min-height:32px;font:inherit;color:var(--dsw-alias-label-primary);text-align:left;background:0 0;border:none;border-radius:8px;align-items:baseline;gap:10px;padding:5px 10px;font-size:13px;line-height:20px;display:flex}.lzhaKq_comboItem:hover{background:var(--dsw-alias-interactive-bg-hover)}.lzhaKq_comboItemHost{text-overflow:ellipsis;white-space:nowrap;flex:0 auto;min-width:0;overflow:hidden}.lzhaKq_comboItemProvider{max-width:55%;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:none;margin-left:auto;font-size:12px;line-height:18px;overflow:hidden}.lzhaKq_comboEmpty{color:var(--dsw-alias-label-tertiary);padding:6px 10px;font-size:12px;line-height:18px}.lzhaKq_save{appearance:none;font:inherit;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.lzhaKq_save:disabled{opacity:.4;cursor:default}.lzhaKq_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.lzhaKq_page{flex-direction:column;gap:4px;display:flex}.lzhaKq_pageIntro{opacity:.75;margin:0 0 12px;font-size:13px;line-height:1.5}";
		const tagId = "dsh-model-http-proxy/card.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-model-http-proxy";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var card_module_css_default = {
			"body": "lzhaKq_body",
			"card": "lzhaKq_card",
			"cardOpen": "lzhaKq_cardOpen",
			"chevron": "lzhaKq_chevron",
			"chevronOpen": "lzhaKq_chevronOpen",
			"chip": "lzhaKq_chip",
			"chipLabel": "lzhaKq_chipLabel",
			"chipRemove": "lzhaKq_chipRemove",
			"combo": "lzhaKq_combo",
			"comboBox": "lzhaKq_comboBox",
			"comboChevron": "lzhaKq_comboChevron",
			"comboChevronOpen": "lzhaKq_comboChevronOpen",
			"comboEmpty": "lzhaKq_comboEmpty",
			"comboEntry": "lzhaKq_comboEntry",
			"comboItem": "lzhaKq_comboItem",
			"comboItemHost": "lzhaKq_comboItemHost",
			"comboItemProvider": "lzhaKq_comboItemProvider",
			"comboList": "lzhaKq_comboList",
			"description": "lzhaKq_description",
			"field": "lzhaKq_field",
			"footer": "lzhaKq_footer",
			"head": "lzhaKq_head",
			"headText": "lzhaKq_headText",
			"header": "lzhaKq_header",
			"hint": "lzhaKq_hint",
			"input": "lzhaKq_input",
			"label": "lzhaKq_label",
			"name": "lzhaKq_name",
			"page": "lzhaKq_page",
			"pageIntro": "lzhaKq_pageIntro",
			"pending": "lzhaKq_pending",
			"readOnly": "lzhaKq_readOnly",
			"save": "lzhaKq_save",
			"status": "lzhaKq_status",
			"statusFailed": "lzhaKq_statusFailed",
			"statusSaved": "lzhaKq_statusSaved"
		};
		//#endregion
		//#region src/client/fields.tsx
		/**
		* Shared form fields for the Model Http Proxy settings page: one labelled
		* text field and a hostname combobox (free text + suggestions dropdown).
		*/
		/**
		* The dropdown chevron, drawn locally instead of imported from the host's
		* primitives module. The icon's export name is not stable across host
		* releases (`IconChevronDownOutline14` on 0.1.x, `IconChevronDownOutlineRegular`
		* on 0.2.x), and requiring the missing name yields `undefined` — which React
		* rejects as an invalid element type (#130) and takes the whole slot entry
		* down with it, leaving the settings page blank. A local SVG has no
		* cross-version surface and keeps the bundle self-contained.
		*/
		function ChevronDown(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				className: props.className,
				width: "14",
				height: "14",
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M4 6.25 8 10.25 12 6.25",
					stroke: "currentColor",
					strokeWidth: "1.4",
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			});
		}
		function ValueField(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: card_module_css_default.field,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: card_module_css_default.head,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: card_module_css_default.label,
							htmlFor: props.id,
							children: props.label
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: props.id,
						className: card_module_css_default.input,
						type: "text",
						value: props.value,
						placeholder: props.placeholder,
						disabled: props.disabled,
						onChange: (event) => {
							props.onEdit(event.target.value);
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: card_module_css_default.hint,
						children: props.hint
					})
				]
			});
		}
		/**
		* A hostname field that behaves like the host's own tag inputs: every
		* committed host is drawn as a removable chip, and the text cursor lives in a
		* bare input at the end of the row. Focus (or the chevron) opens a dropdown of
		* the providers that are actually configured. Enter or a comma commits what is
		* typed, Backspace on an empty entry drops the last chip, Arrow keys move the
		* highlight, Enter picks a suggestion, Escape closes the list.
		*
		* The chips are the value: `value` is the parsed host list and `onChange`
		* always hands back a whole new list, so the page never has to split text.
		*/
		function HostField(props) {
			const [pending, setPending] = (0, react.useState)("");
			const [open, setOpen] = (0, react.useState)(false);
			const [highlight, setHighlight] = (0, react.useState)(0);
			const present = new Set(props.value.map((host) => normalizeHostEntry(host)).filter((host) => host !== void 0));
			const query = pending.trim().toLowerCase();
			const options = props.suggestions.filter((option) => !present.has(option.host) && (query === "" || option.host.includes(query) || option.providers.some((name) => name.toLowerCase().includes(query))));
			const active = open && highlight >= 0 && highlight < options.length ? highlight : -1;
			/** Commit one or more hosts, de-duplicated against what is already selected. */
			const commit = (text) => {
				if (props.disabled) return;
				const parts = text.split(/[,，\s]+/).map((part) => part.trim()).filter((part) => part.length > 0);
				if (parts.length === 0) return;
				const next = [...props.value];
				for (const part of parts) {
					const normalized = normalizeHostEntry(part);
					if (normalized === void 0) continue;
					if (next.some((existing) => normalizeHostEntry(existing) === normalized)) continue;
					next.push(part);
				}
				setPending("");
				if (next.length !== props.value.length) props.onChange(next);
			};
			/** Drop the chip at one index; the rest of the list keeps its order. */
			const remove = (index) => {
				if (props.disabled) return;
				props.onChange(props.value.filter((_, position) => position !== index));
			};
			const move = (delta) => {
				if (options.length === 0) return;
				setHighlight((current) => (current + delta + options.length) % options.length);
			};
			const onKeyDown = (event) => {
				if (event.key === "Escape") {
					setOpen(false);
					return;
				}
				if (event.key === "Enter") {
					event.preventDefault();
					if (open && options.length > 0 && pending.trim() === "") {
						const pick = options[active >= 0 ? active : 0];
						if (pick !== void 0) commit(pick.host);
						return;
					}
					if (open && options.length > 0 && active >= 0) {
						const pick = options[active];
						if (pick !== void 0) {
							commit(pick.host);
							return;
						}
					}
					commit(pending);
					return;
				}
				if (event.key === "Backspace" && pending === "" && props.value.length > 0) {
					event.preventDefault();
					remove(props.value.length - 1);
					return;
				}
				if (event.key === "ArrowDown") {
					event.preventDefault();
					if (!open) {
						setOpen(true);
						setHighlight(0);
						return;
					}
					move(1);
					return;
				}
				if (event.key === "ArrowUp") {
					event.preventDefault();
					if (!open) {
						setOpen(true);
						setHighlight(options.length - 1);
						return;
					}
					move(-1);
					return;
				}
				if (event.key === "Home" && open) {
					event.preventDefault();
					setHighlight(0);
					return;
				}
				if (event.key === "End" && open) {
					event.preventDefault();
					setHighlight(options.length - 1);
					return;
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: card_module_css_default.field,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: card_module_css_default.head,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: card_module_css_default.label,
							htmlFor: props.id,
							children: props.label
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: card_module_css_default.combo,
						onBlur: (event) => {
							if (event.currentTarget.contains(event.relatedTarget)) return;
							setOpen(false);
							commit(pending);
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: card_module_css_default.comboBox,
								children: [props.value.map((host, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: card_module_css_default.chip,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: card_module_css_default.chipLabel,
										children: host
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: card_module_css_default.chipRemove,
										"aria-label": `不再代理 ${host}`,
										disabled: props.disabled,
										onMouseDown: (event) => {
											event.preventDefault();
										},
										onClick: () => {
											remove(index);
										},
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
											width: "10",
											height: "10",
											viewBox: "0 0 10 10",
											fill: "none",
											"aria-hidden": "true",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
												d: "M2 2 8 8M8 2 2 8",
												stroke: "currentColor",
												strokeWidth: "1.4",
												strokeLinecap: "round"
											})
										})
									})]
								}, `${host}-${index}`)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									id: props.id,
									className: card_module_css_default.comboEntry,
									type: "text",
									role: "combobox",
									"aria-expanded": open,
									"aria-controls": `${props.id}-list`,
									"aria-autocomplete": "list",
									"aria-activedescendant": active >= 0 ? `${props.id}-opt-${active}` : void 0,
									value: pending,
									placeholder: props.value.length === 0 ? props.placeholder : "",
									disabled: props.disabled,
									onFocus: () => {
										setOpen(true);
										setHighlight(0);
									},
									onChange: (event) => {
										const text = event.target.value;
										if (/[,，]/.test(text)) {
											const parts = text.split(/[,，]/);
											commit(parts.slice(0, -1).join(","));
											setPending(parts[parts.length - 1] ?? "");
											setOpen(true);
											setHighlight(0);
											return;
										}
										setPending(text);
										setOpen(true);
										setHighlight(0);
									},
									onKeyDown
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: card_module_css_default.comboChevron,
								"aria-label": "选择域名",
								"aria-expanded": open,
								tabIndex: -1,
								disabled: props.disabled,
								onMouseDown: (event) => {
									event.preventDefault();
								},
								onClick: () => {
									const next = !open;
									setOpen(next);
									if (next) setHighlight(0);
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChevronDown, { className: open ? card_module_css_default.comboChevronOpen : void 0 })
							}),
							open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: card_module_css_default.comboList,
								id: `${props.id}-list`,
								role: "listbox",
								children: options.length > 0 ? options.map((option, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
									role: "option",
									id: `${props.id}-opt-${index}`,
									"aria-selected": index === active,
									onMouseEnter: () => {
										setHighlight(index);
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: card_module_css_default.comboItem,
										onMouseDown: (event) => {
											event.preventDefault();
										},
										onClick: () => {
											commit(option.host);
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: card_module_css_default.comboItemHost,
											children: option.host
										}), option.providers.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: card_module_css_default.comboItemProvider,
											children: option.providers.join(" · ")
										}) : null]
									})
								}, option.host)) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
									className: card_module_css_default.comboEmpty,
									children: "没有可选的域名"
								})
							}) : null
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: card_module_css_default.hint,
						children: props.hint
					})
				]
			});
		}
		//#endregion
		//#region src/client/page.tsx
		/**
		* The M-H-Proxy settings page (settings.section left-nav entry): the three
		* form fields rendered expanded — no collapsible card chrome, the nav itself
		* is the entry point. The page owns its local state (mindmap's SettingsPanel
		* shape): read once on mount through the proxy face, stage drafts, write only
		* on save.
		*/
		/** The normalized form of a list, for cross-field "already used there" checks. */
		function hostSetOf(list) {
			const set = /* @__PURE__ */ new Set();
			for (const host of list) {
				const normalized = normalizeHostEntry(host);
				if (normalized !== void 0) set.add(normalized);
			}
			return set;
		}
		/** Order-free compare of two host lists (same hosts, any order). */
		function sameHosts(left, right) {
			if (left.length !== right.length) return false;
			const seen = new Set(left);
			return right.every((host) => seen.has(host));
		}
		/**
		* Render the M-H-Proxy settings page.
		* @param props - the proxy face this page reads and writes through.
		* @returns the page, a loading note, or the read error — never a silent blank.
		*/
		function ModelProxyPage(props) {
			const face = props.proxyFace;
			const [loaded, setLoaded] = (0, react.useState)(null);
			const [draft, setDraft] = (0, react.useState)(null);
			const [suggestions, setSuggestions] = (0, react.useState)([]);
			const [error, setError] = (0, react.useState)("");
			const [notice, setNotice] = (0, react.useState)("");
			const [saving, setSaving] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				let alive = true;
				if (!face) return;
				face.read().then((snapshot) => {
					if (!alive) return;
					if (!snapshot) {
						setError("设置服务不可用：settings namespace 未注册或宿主连接缺失");
						return;
					}
					setLoaded({
						proxy: snapshot.proxy,
						proxyHosts: snapshot.proxyHosts,
						excludeHosts: snapshot.excludeHosts
					});
					setDraft({
						proxy: snapshot.proxy,
						proxyHosts: snapshot.proxyHosts,
						excludeHosts: snapshot.excludeHosts
					});
					setSuggestions(snapshot.suggestions);
				}).catch((err) => {
					if (alive) setError(String(err?.message ?? err));
				});
				return () => {
					alive = false;
				};
			}, [face]);
			if (!face) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: card_module_css_default.pageIntro,
				children: "M-H-Proxy 面板未注入。"
			});
			if (draft === null || loaded === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: card_module_css_default.pageIntro,
				children: error || "正在读取设置…"
			});
			const proxyTaken = hostSetOf(draft.excludeHosts);
			const excludeTaken = hostSetOf(draft.proxyHosts);
			const proxySuggestions = suggestions.filter((option) => !proxyTaken.has(option.host));
			const excludeSuggestions = suggestions.filter((option) => !excludeTaken.has(option.host));
			const dirty = draft.proxy !== loaded.proxy || !sameHosts(draft.proxyHosts, loaded.proxyHosts) || !sameHosts(draft.excludeHosts, loaded.excludeHosts);
			async function save() {
				if (!face || !draft) return;
				setSaving(true);
				setError("");
				setNotice("");
				try {
					const fields = {
						proxy: draft.proxy.trim(),
						proxyHosts: draft.proxyHosts,
						excludeHosts: draft.excludeHosts
					};
					await face.save(fields);
					setLoaded(fields);
					setDraft({
						proxy: fields.proxy,
						proxyHosts: fields.proxyHosts,
						excludeHosts: fields.excludeHosts
					});
					setNotice("已保存 ✓");
				} catch (err) {
					setError(String(err?.message ?? err));
				} finally {
					setSaving(false);
				}
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: card_module_css_default.page,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: card_module_css_default.pageIntro,
						children: "给模型 API 请求配置正向代理；web 搜索等其它请求仍直连。留空代理地址则插件不生效，设置保存后下一次请求即生效。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ValueField, {
						id: "model-proxy-url",
						label: "代理地址",
						hint: "支持 http / https / socks4 / socks4a / socks5 / socks5h；留空则插件不生效。",
						placeholder: "socks5://127.0.0.1:7890",
						value: draft.proxy,
						disabled: saving,
						onEdit: (text) => {
							setDraft({
								...draft,
								proxy: text
							});
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(HostField, {
						id: "model-proxy-hosts",
						label: "只代理这些域名",
						hint: "留空 = 自动代理所有模型域名；填写 = 只代理下面的这些域名。回车或逗号确认输入，点标签右上角的 × 移除；下拉里只列出激活的提供方，已经在「排除域名」里的不会再出现，也支持直接输入域名 / 域名:端口 / URL / .域名后缀。",
						placeholder: "输入域名后回车，或从下拉选择",
						value: draft.proxyHosts,
						suggestions: proxySuggestions,
						disabled: saving,
						onChange: (next) => {
							setDraft({
								...draft,
								proxyHosts: next
							});
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(HostField, {
						id: "model-proxy-exclude",
						label: "排除域名",
						hint: "永远不走代理，优先级最高。回车或逗号确认输入，点标签右上角的 × 移除；已经在「只代理这些域名」里的不会再出现，同样支持直接输入域名 / 域名:端口 / URL / .域名后缀。",
						placeholder: "api.deepseek.com",
						value: draft.excludeHosts,
						suggestions: excludeSuggestions,
						disabled: saving,
						onChange: (next) => {
							setDraft({
								...draft,
								excludeHosts: next
							});
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: card_module_css_default.footer,
						children: [error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: `${card_module_css_default.status} ${card_module_css_default.statusFailed}`,
							role: "status",
							children: error
						}) : notice ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: card_module_css_default.status,
							role: "status",
							children: notice
						}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: card_module_css_default.save,
							disabled: !dirty || saving,
							onClick: () => {
								save();
							},
							children: saving ? "保存中…" : "保存"
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/settings-io.ts
		/** Settings namespace the Host half owns; keep in sync with src/index.ts. */
		const NS = "model-proxy";
		/** The `llm-pi-ai` namespace, read-only here, supplying gateway hostname suggestions. */
		const PI_AI_NS = "llm-pi-ai";
		/**
		* Extract the namespace descriptor rows from any describe envelope shape:
		* `{ok, value}` (remote facade), a bare array (0.1.2 provider), `{value}` /
		* `{result:{value}}` (connection-era proxies), or the pre-aggregation
		* `{namespaces}` object. Unknown shapes degrade to an empty list — the caller
		* treats that as “namespace not found”, never as an authoritative empty value.
		*/
		function settingsNamespacesOf(res) {
			const source = res;
			let value;
			if (source && typeof source === "object" && source.ok === true) value = source.value;
			else if (Array.isArray(res)) value = res;
			else if (source && typeof source === "object" && Array.isArray(source.value)) value = source.value;
			else if (source && typeof source === "object" && source.result) value = source.result.value;
			else value = res;
			if (Array.isArray(value)) return value;
			const list = value?.namespaces;
			return Array.isArray(list) ? list : [];
		}
		/** Read a service without inject declarations: undefined when absent, never a throw. */
		function serviceOf(ctx, id) {
			try {
				const get = ctx.get;
				return typeof get === "function" ? get.call(ctx, id) : void 0;
			} catch {
				return;
			}
		}
		/** Resolve the settings api generation available on this host, or null. */
		function settingsApiOf(ctx) {
			const remote = serviceOf(ctx, "remote.settings");
			if (remote && typeof remote.describe === "function") return {
				kind: "remote",
				settings: remote
			};
			const settings = serviceOf(ctx, "connection")?.api?.settings;
			if (settings && typeof settings.describe === "function") return {
				kind: "connection",
				settings
			};
			return null;
		}
		/** Read the revision a write landed on, so the next save checks against it. */
		function revisionOf(res) {
			const revision = (res?.value)?.revision;
			return typeof revision === "number" && Number.isInteger(revision) ? revision : null;
		}
		/** Reject a write whose response envelope is missing or explicitly `ok:false`. */
		function unwrapWrite(res, what) {
			if (res && typeof res === "object" && res.ok === true) return;
			const message = res?.error?.message;
			throw new Error(message ?? `${what} failed`);
		}
		/**
		* Collect the hosts offered by the two host fields: the providers that are
		* actually active, not the whole catalog. Two sources, both of which matter:
		*
		*  - the routes the host currently serves models for
		*    (`session.modelCatalog`'s `routableProviders`) — this is what puts a
		*    plugin-registered provider such as the Codex subscription
		*    (`openai-codex` → chatgpt.com) or the official DeepSeek adapters in the
		*    list, and it is also the only source that knows a provider exists;
		*  - the profiles configured in `llm-pi-ai.providers`, each resolved to its own
		*    `baseURL` for a custom gateway (azapi/zenmux/…) or to the catalog endpoint
		*    of that route otherwise (kimi-coding/…).
		*
		* Once a route is known, its host comes from `providerEndpointHost`. Saved
		* entries are always included so nothing on the page becomes unremovable.
		*/
		function suggestionsOf(fields, piAiValue, catalog) {
			const byHost = /* @__PURE__ */ new Map();
			const providers = piAiValue?.providers;
			const profileOf = (route) => providers && typeof providers === "object" ? providers[route] : void 0;
			const add = (route, label) => {
				const host = providerEndpointHost(route, profileOf(route)?.baseURL);
				if (host === void 0) return;
				const names = byHost.get(host) ?? /* @__PURE__ */ new Set();
				names.add(label);
				byHost.set(host, names);
			};
			for (const route of catalog.routes) {
				const configured = profileOf(route)?.displayName;
				add(route, typeof configured === "string" && configured.length > 0 ? configured : catalog.names.get(route) ?? route);
			}
			if (providers && typeof providers === "object") for (const [route, profile] of Object.entries(providers)) {
				const host = providerEndpointHost(route, profile?.baseURL);
				if (host === void 0 || byHost.has(host)) continue;
				const configured = profile?.displayName;
				byHost.set(host, /* @__PURE__ */ new Set([typeof configured === "string" && configured.length > 0 ? configured : route]));
			}
			if (catalog.routes.length === 0 && !byHost.has("api.deepseek.com")) byHost.set(DEFAULT_DEEPSEEK_HOST, /* @__PURE__ */ new Set(["DeepSeek"]));
			const addList = (list) => {
				if (!Array.isArray(list)) return;
				for (const host of list) {
					if (typeof host !== "string") continue;
					const normalized = normalizeHostEntry(host);
					if (normalized !== void 0 && !byHost.has(normalized)) byHost.set(normalized, /* @__PURE__ */ new Set());
				}
			};
			addList(fields.proxyHosts);
			addList(fields.excludeHosts);
			return [...byHost.entries()].map(([host, names]) => ({
				host,
				providers: [...names]
			})).sort((left, right) => left.host.localeCompare(right.host));
		}
		/**
		* Ask the host which provider routes currently serve models, and what they are
		* called. This is the only way to see a provider another plugin registered (the
		* Codex subscription adds `openai-codex` straight to the pi-ai adapter, so it
		* never appears in the `llm-pi-ai` settings document).
		* @param ctx - the browser plugin context.
		* @returns the routable routes and their names; empty when the call fails.
		*/
		async function providerCatalogOf(ctx) {
			const empty = {
				routes: [],
				names: /* @__PURE__ */ new Map()
			};
			const remote = serviceOf(ctx, "remote.session");
			if (!remote || typeof remote.modelCatalog !== "function") return empty;
			try {
				const res = await remote.modelCatalog();
				const envelope = res;
				const catalog = envelope && envelope.ok === true ? envelope.value : envelope?.value ?? res;
				const routes = Array.isArray(catalog?.routableProviders) ? catalog.routableProviders.filter((route) => typeof route === "string") : [];
				const names = /* @__PURE__ */ new Map();
				if (Array.isArray(catalog?.groups)) for (const group of catalog.groups) {
					const row = group;
					if (typeof row?.id === "string" && typeof row.name === "string" && row.name.length > 0) names.set(row.id, row.name);
				}
				return {
					routes,
					names
				};
			} catch {
				return empty;
			}
		}
		/** Coerce a namespace value into the page's fields, defaulting absent members. */
		function fieldsOf(value) {
			const row = value && typeof value === "object" ? value : {};
			const listOf = (input) => Array.isArray(input) ? input.filter((item) => typeof item === "string") : [];
			return {
				proxy: typeof row.proxy === "string" ? row.proxy : "",
				proxyHosts: listOf(row.proxyHosts),
				excludeHosts: listOf(row.excludeHosts)
			};
		}
		/**
		* Build the M-H-Proxy face over the resolved settings api.
		* @param ctx - the browser plugin context.
		* @returns the face the settings page consumes.
		*/
		function createProxyFace(ctx) {
			let describedRevision = null;
			return {
				async read() {
					const api = settingsApiOf(ctx);
					if (!api) return null;
					const rows = settingsNamespacesOf(api.kind === "remote" ? await api.settings.describe() : await api.settings.describe({}));
					const own = rows.find((row) => row?.ns === NS);
					if (!own) return null;
					const revision = own.revision;
					describedRevision = typeof revision === "number" && Number.isInteger(revision) ? revision : null;
					const fields = fieldsOf(own.value);
					const piAi = rows.find((row) => row?.ns === PI_AI_NS);
					const catalog = await providerCatalogOf(ctx);
					return {
						...fields,
						suggestions: suggestionsOf(fields, piAi?.value, catalog)
					};
				},
				async save(fields) {
					const api = settingsApiOf(ctx);
					if (!api) throw new Error("settings service unavailable");
					if (api.kind === "remote") {
						if (typeof api.settings.mutate !== "function") throw new Error("settings.mutate unavailable");
						const ops = [
							{
								op: "set",
								path: ["proxy"],
								value: fields.proxy
							},
							{
								op: "set",
								path: ["proxyHosts"],
								value: fields.proxyHosts
							},
							{
								op: "set",
								path: ["excludeHosts"],
								value: fields.excludeHosts
							}
						];
						const written = await api.settings.mutate(NS, ops, describedRevision ?? void 0);
						unwrapWrite(written, "settings.mutate");
						describedRevision = revisionOf(written);
						return;
					}
					if (typeof api.settings.update !== "function") throw new Error("settings.update unavailable");
					await api.settings.update({
						ns: NS,
						patch: { ...fields }
					});
				}
			};
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services (cordis fiber inject). */
		const inject = ["slots"];
		/**
		* Mount the M-H-Proxy settings page.
		* @param ctx - the browser plugin context.
		*/
		function apply(ctx) {
			const face = createProxyFace(ctx);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-model-http-proxy",
				order: 100,
				label: "M-H-Proxy",
				inject: () => ({ proxyFace: face })
			}, ModelProxyPage));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map