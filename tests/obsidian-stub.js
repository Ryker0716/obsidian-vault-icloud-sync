'use strict';

/*
 * 极简 Obsidian / DOM 桩，让 main.js 能在纯 node 里跑。
 * 只实现本插件用到的那一小撮 API：Plugin / PluginSettingTab / Setting / Notice / Modal。
 */

const notices = [];

function makeEl(tag, opts = {}) {
	const el = {
		tag,
		text: opts.text || '',
		cls: opts.cls || '',
		children: [],
		listeners: {},
		style: {},
		rows: 1,
		value: opts.value || '',
		type: opts.type || '',
		createEl(t, o) {
			const c = makeEl(t, o);
			el.children.push(c);
			return c;
		},
		createDiv(o) {
			return el.createEl('div', o);
		},
		createSpan(o) {
			return el.createEl('span', o);
		},
		setText(t) {
			el.text = String(t);
		},
		empty() {
			el.children = [];
		},
		addClass(c) {
			el.cls = `${el.cls} ${c}`.trim();
		},
		setAttribute() {},
		addEventListener(name, fn) {
			el.listeners[name] = fn;
		},
		appendChild(c) {
			el.children.push(c);
		},
		setValue() {},
	};
	return el;
}

function walk(el, fn) {
	fn(el);
	for (const c of el.children) walk(c, fn);
}

let planHook = null;
function setPlanHook(fn) {
	planHook = fn;
}

class Modal {
	constructor(app) {
		this.app = app;
		this.contentEl = makeEl('div');
	}
	open() {
		this.onOpen();
		if (planHook && planHook(this)) return;
		if (global.__AUTO_CANCEL) {
			this.close();
			return;
		}
		if (this.opts && this.opts.checkboxLabel && !global.__FORCE_UNCHECKED) this.checked = true;
		if (this.items) {
			if (Array.isArray(global.__SELECT_ONLY)) {
				this.selected = new Set(global.__SELECT_ONLY);
				if (typeof this.updateSummary === 'function') this.updateSummary();
			} else if (!global.__NO_SELECTION) {
				for (const it of this.items) this.selected.add(it.path);
				if (typeof this.updateSummary === 'function') this.updateSummary();
			}
		}
		let target = null;
		walk(this.contentEl, (el) => {
			if (el.tag === 'button' && /mod-warning|mod-cta/.test(el.cls)) target = el;
		});
		if (target && target.listeners.click) {
			target.listeners.click();
			if (this.items && this.selected.size === 0) this.close();
		} else this.close();
	}
	close() {
		this.onClose();
	}
}

class Notice {
	constructor(msg) {
		this.msg = msg;
		notices.push(String(msg));
	}
	setMessage(m) {
		this.msg = m;
	}
	hide() {}
}

class Plugin {
	constructor(app, manifest) {
		this.app = app;
		this.manifest = manifest || {};
	}
}

class PluginSettingTab {
	constructor(app, plugin) {
		this.app = app;
		this.plugin = plugin;
	}
}

class Setting {
	constructor(el) {
		this.el = makeEl('div');
		this.value = false;
		if (el && el.appendChild) el.appendChild(this.el);
	}
	setName(n) {
		this.name = n;
		this.el.createSpan({ text: n });
		return this;
	}
	setDesc(d) {
		this.desc = d;
		return this;
	}
	addButton(cb) {
		const b = makeEl('button');
		const api = {
			setButtonText: (t) => {
				b.text = t;
				return api;
			},
			setCta: () => api,
			setWarning: () => api,
			setTooltip: () => api,
			onClick: (fn) => {
				b.listeners.click = fn;
				return api;
			},
		};
		if (cb) cb(api);
		this.el.children.push(b);
		return this;
	}
	addToggle(cb) {
		const api = {
			setValue: (v) => {
				this.value = !!v;
				return api;
			},
			onChange: (fn) => {
				this.onChange = fn;
				return api;
			},
		};
		if (cb) cb(api);
		return this;
	}
	addText(cb) {
		const api = {
			setPlaceholder: () => api,
			setValue: () => api,
			onChange: () => api,
		};
		if (cb) cb(api);
		return this;
	}
	addTextArea(cb) {
		if (cb) cb({ setValue: () => ({ onChange: () => {} }), inputEl: { rows: 1, style: {} } });
		return this;
	}
}

module.exports = { Plugin, PluginSettingTab, Setting, Notice, Modal, notices, makeEl, walk, setPlanHook };
