'use strict';

/*
 * vault-icloud-sync —— 本地 vault → iCloud 备份目录 单向同步
 *
 * 行为：
 *   1. 每天首次启动 Obsidian，等到工作区就绪后延迟 N 秒（默认 60 秒）；
 *   2. 插件自己扫描两边的目录树做比对（文件大小 + 修改时间，可选内容校验）；
 *   3. 只要存在「新增/更新」就用 rsync 真正同步一次；默认不删除 iCloud 侧多余文件；
 *   4. 结果通过 Notice 提示，并写入插件目录下的 sync.log。
 *
 * 两个反向操作（设置页底部按钮 / 命令面板，执行前都会弹确认框）：
 *   - 按备份恢复本仓库：iCloud 备份 → 本地，覆盖本地内容；默认不删除本地独有文件，
 *     勾选后把它们移进本地 vault 的 .vault-sync-trash/ 回收目录。
 *   - 清理备份冗余：把「备份里有、本地已没有」的文件移进备份目录下的
 *     .vault-sync-trash/<时间戳>/，等价于手工跑一次镜像删除，但不改动「镜像删除」设置本身。
 *
 * 为什么不解析 rsync -i 的输出来判断差异：
 *   macOS 自带的 /usr/bin/rsync 其实是 openrsync，它会把非 ASCII 文件名
 *   转义成 \#ooo 形式（例如「战略.md」→「\#210\#230\#225.md」），中文文件名
 *   全部对不上，因此差异判断必须自己做。
 *
 * 为什么不用 rsync 的 --backup-dir 做回收站：
 *   macOS 的 openrsync 在 --delete 与 --backup-dir 同时使用时，会静默跳过删除。
 *   所以回收动作由插件自己用 fs.rename 完成。
 *
 * 仅桌面端可用（依赖 Node 的 child_process / fs）。
 */

const { Plugin, PluginSettingTab, Setting, Notice, Modal } = require('obsidian');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TRASH_DIR_NAME = '.vault-sync-trash';
const LOG_NAME = 'sync.log';
const LOG_MAX_BYTES = 512 * 1024;
const SAMPLE_LIMIT = 30;
const MODAL_SAMPLE_LIMIT = 15;

const DEFAULT_SETTINGS = {
	autoEnabled: true,
	delaySeconds: 60,
	// iCloud 备份目录（同步目标），首次使用需在设置里填写
	remoteRoot: '',
	// 本地 vault 根目录，留空表示「当前打开的 vault」
	localRoot: '',
	// true 时按文件内容（MD5）比对，最准，但每天要读全量文件（两边各一遍），大仓库会明显变慢
	checksum: false,
	// true 时把 iCloud 侧「本地已不存在」的文件移进回收目录
	mirrorDelete: false,
	notifyOnSuccess: true,
	notifyOnNoChange: false,
	timeoutSeconds: 1800,
	rsyncPath: '/usr/bin/rsync',
	// 以 / 开头 = 只排除 vault 根目录下的这一项；不含 / = 按文件名匹配任意层级
	excludes: [
		'/.trash',
		'/.agents',
		'/.claude',
		'/.claudeignore',
		'/.claudian',
		'/.copilot',
		'/.gitignore',
		'/.obsidian',
		'/.omo',
		'/.opencode',
		'/.opencodeignore',
		'/.vault-sync-trash',
		'.DS_Store',
	],
};

const DEFAULT_STATE = {
	lastAutoDate: '',
	lastRun: null,
	lastRestore: null,
	lastClean: null,
	lastPlan: null,
};

/* ------------------------------------------------------------------ 工具函数 */

function withSlash(p) {
	return p.endsWith(path.sep) ? p : p + path.sep;
}

function pad2(n) {
	return String(n).padStart(2, '0');
}

function dateKey(d = new Date()) {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function stamp(d = new Date()) {
	return (
		`${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
		`${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
	);
}

function timeText(d = new Date()) {
	return `${dateKey(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function firstLine(s) {
	const t = String(s || '').trim();
	if (!t) return '';
	return t.split('\n')[0].trim();
}

function samePath(a, b) {
	return path.resolve(a) === path.resolve(b);
}

/* ---------------------------------------------------------------------- 插件 */

class VaultICloudSyncPlugin extends Plugin {
	async onload() {
		await this.loadAll();
		this.timer = null;
		this.running = false;
		this.hashCache = new Map();
		this.logPath = this.resolveLogPath();
		this.trimLog();

		this.addRibbonIcon('refresh-cw', '同步到 iCloud 备份', () => this.runSync('manual'));
		this.addSettingTab(new VaultICloudSyncSettingTab(this.app, this));

		this.addCommand({
			id: 'sync-now',
			name: '立即同步到 iCloud 备份',
			callback: () => this.runSync('manual'),
		});
		this.addCommand({
			id: 'check-only',
			name: '仅检查差异（逐项选择备份或还原）',
			callback: () => this.openDiffPlan(),
		});
		this.addCommand({
			id: 'show-last',
			name: '查看上次同步结果',
			callback: () => this.showLastResult(),
		});
		this.addCommand({
			id: 'restore-from-backup',
			name: '按备份恢复本仓库（iCloud → 本地）',
			callback: () => this.runRestore(),
		});
		this.addCommand({
			id: 'clean-remote-extras',
			name: '按本仓库情况清理备份冗余文件',
			callback: () => this.runCleanRemote(),
		});
		this.addCommand({
			id: 'reset-daily-flag',
			name: '重置「今日已自动同步」标记',
			callback: async () => {
				this.state.lastAutoDate = '';
				await this.saveAll();
				new Notice('已重置，重新加载 Obsidian（或重启）后今日会再次自动同步');
			},
		});

		this.app.workspace.onLayoutReady(() => this.scheduleDaily());
	}

	onunload() {
		if (this.timer) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/* ---------------------------------------------------------- 数据读写 */

	async loadAll() {
		const data = (await this.loadData()) || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
		if (!Array.isArray(this.settings.excludes)) {
			this.settings.excludes = DEFAULT_SETTINGS.excludes.slice();
		}
		this.state = Object.assign({}, DEFAULT_STATE, data.state || {});
	}

	async saveAll() {
		await this.saveData({ settings: this.settings, state: this.state });
	}

	/** manifest.dir 偶发为空，这里退回按 vault 配置目录推算 */
	resolveLogPath() {
		const id = (this.manifest && this.manifest.id) || 'vault-icloud-sync';
		let dir = this.manifest && this.manifest.dir;
		if (!dir) {
			const base = this.vaultRoot();
			if (base) dir = path.join(base, this.app.vault.configDir || '.obsidian', 'plugins', id);
		}
		return dir ? path.join(dir, LOG_NAME) : null;
	}

	trimLog() {
		if (!this.logPath) return;
		try {
			const st = fs.statSync(this.logPath);
			if (st.size <= LOG_MAX_BYTES) return;
			const lines = fs.readFileSync(this.logPath, 'utf8').split('\n');
			fs.writeFileSync(this.logPath, lines.slice(-800).join('\n'), 'utf8');
		} catch (e) {
			/* 日志不存在或不可写，忽略 */
		}
	}

	log(line) {
		console.log(`[vault-icloud-sync] ${line}`);
		if (!this.logPath) return;
		try {
			fs.appendFileSync(this.logPath, `[${timeText()}] ${line}\n`, 'utf8');
		} catch (e) {
			/* 忽略日志写入失败 */
		}
	}

	/* ---------------------------------------------------------- 每日调度 */

	scheduleDaily() {
		if (!this.isDesktop()) return;
		if (!this.settings.autoEnabled) {
			this.log('每日自动同步已关闭，跳过调度');
			return;
		}

		const today = dateKey();
		if (this.state.lastAutoDate === today) {
			this.log(`今日（${today}）已执行过自动同步，跳过`);
			return;
		}

		const delay = Math.max(0, Number(this.settings.delaySeconds) || 0);
		this.log(`Obsidian 已就绪，将于 ${delay} 秒后执行今日首次自动同步`);
		if (delay > 0) {
			new Notice(`iCloud 备份同步将在 ${delay} 秒后自动执行`, 5000);
		}
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.runSync('auto');
		}, delay * 1000);
	}

	isDesktop() {
		return !!(this.app.vault.adapter && typeof this.app.vault.adapter.getBasePath === 'function');
	}

	vaultRoot() {
		try {
			if (typeof this.app.vault.adapter.getBasePath === 'function') {
				return this.app.vault.adapter.getBasePath();
			}
			return this.app.vault.adapter.basePath || null;
		} catch (e) {
			return null;
		}
	}

	/* ---------------------------------------------------------- 路径校验 */

	resolvePaths(mode, opts = {}) {
		const vaultRoot = this.vaultRoot();
		if (!vaultRoot) {
			new Notice('❌ 该插件仅支持桌面端（需要访问本地文件系统）');
			return null;
		}

		const localRoot = (this.settings.localRoot || '').trim() || vaultRoot;
		const remoteRoot = (this.settings.remoteRoot || '').trim();

		if (!remoteRoot) {
			new Notice('❌ 未配置 iCloud 备份目录，请到插件设置里填写');
			return null;
		}
		const isDir = (dp) => {
			try {
				return fs.statSync(dp).isDirectory();
			} catch (e) {
				return false;
			}
		};
		if (!fs.existsSync(localRoot)) {
			new Notice(`❌ 本地 vault 目录不存在：${localRoot}`);
			return null;
		}
		if (!isDir(localRoot)) {
			new Notice(`❌ 本地 vault 根目录不是一个文件夹：${localRoot}`);
			return null;
		}
		if (!fs.existsSync(remoteRoot)) {
			new Notice(`❌ iCloud 备份目录不存在（是否未登录 iCloud / 路径拼写有误？）：\n${remoteRoot}`, 12000);
			return null;
		}
		if (!isDir(remoteRoot)) {
			new Notice(`❌ iCloud 备份目录不是一个文件夹：${remoteRoot}`);
			return null;
		}
		if (samePath(localRoot, remoteRoot)) {
			this.log(`跳过：本地目录与 iCloud 目录相同（${localRoot}），当前打开的很可能仍是 iCloud 里的 vault`);
			new Notice('⚠️ 本地目录与 iCloud 目录相同，无需同步。\n请确认 Obsidian 打开的是本地 vault。', 10000);
			return null;
		}
		if (!samePath(vaultRoot, localRoot)) {
			const msg = `当前打开的 vault（${vaultRoot}）不是配置的本地目录（${localRoot}）`;
			this.log(`警告：${msg}`);
			// 恢复 / 清理会真正改写文件，路径不一致时一律中止，不做「善意继续」
			if (mode === 'auto' || opts.strictRoot) {
				new Notice(`❌ 已中止：${msg}`, 10000);
				return null;
			}
			new Notice(`⚠️ ${msg}\n仍按手动指令继续同步。`, 8000);
		}

		return { vaultRoot, localRoot, remoteRoot };
	}

	/* ---------------------------------------------------------- 目录树比对 */

	isExcluded(relPath, name) {
		for (const raw of this.settings.excludes || []) {
			let p = String(raw || '').trim();
			if (!p) continue;
			// 与 rsync --exclude 同语义：前导 / 锚定根目录；
			// 不带前导 / 但含 / 的按「路径尾部」匹配任意层级；不含 / 的按文件名匹配任意层级
			const anchored = p.startsWith('/');
			const infix = !anchored && p.indexOf('/') !== -1;
			p = p.replace(/^\/+/, '').replace(/\/+$/, '');
			if (!p) continue;
			if (anchored) {
				if (relPath === p || relPath.startsWith(p + '/')) return true;
			} else if (infix) {
				if (relPath === p || relPath.endsWith('/' + p)) return true;
			} else if (name === p) {
				return true;
			}
		}
		return false;
	}

	/** 扫描目录树，返回 Map<相对路径, 条目> */
	walkTree(root) {
		const entries = new Map();
		const stack = [''];
		while (stack.length) {
			const rel = stack.pop();
			const abs = rel ? path.join(root, rel) : root;
			let names;
			try {
				names = fs.readdirSync(abs, { withFileTypes: true });
			} catch (e) {
				continue;
			}
			for (const ent of names) {
				const childRel = rel ? `${rel}/${ent.name}` : ent.name;
				if (this.isExcluded(childRel, ent.name)) continue;
				const childAbs = path.join(root, childRel);
				let st;
				try {
					st = fs.lstatSync(childAbs);
				} catch (e) {
					continue;
				}
				if (st.isDirectory()) {
					entries.set(childRel, { dir: true, abs: childAbs });
					stack.push(childRel);
				} else if (st.isSymbolicLink()) {
					let link = '';
					try {
						link = fs.readlinkSync(childAbs);
					} catch (e) {
						/* 读不到就当作不同 */
					}
					entries.set(childRel, { dir: false, link, abs: childAbs });
				} else if (st.isFile()) {
					entries.set(childRel, {
						dir: false,
						size: st.size,
						mtime: Math.floor(st.mtimeMs / 1000),
						abs: childAbs,
					});
				}
				// socket / fifo 等其它类型忽略
			}
		}
		return entries;
	}

	hashFile(abs) {
		if (this.hashCache.has(abs)) return this.hashCache.get(abs);
		let h = null;
		try {
			h = crypto.createHash('md5').update(fs.readFileSync(abs)).digest('hex');
		} catch (e) {
			h = null;
		}
		this.hashCache.set(abs, h);
		return h;
	}

	sameEntry(a, b) {
		if (!a || !b) return false;
		if (a.dir !== b.dir) return false;
		if (a.dir) return true; // 目录只看存在性，不看 mtime
		if (a.link !== undefined || b.link !== undefined) return a.link === b.link;
		if (a.size !== b.size) return false;
		if (this.settings.checksum) return this.hashFile(a.abs) === this.hashFile(b.abs);
		return a.mtime === b.mtime;
	}

	compareTrees(local, remote) {
		const created = [];
		const updated = [];
		const extra = [];
		for (const [rel, l] of local) {
			const r = remote.get(rel);
			if (!r) created.push(l.dir ? rel + '/' : rel);
			else if (!this.sameEntry(l, r)) updated.push(l.dir ? rel + '/' : rel);
		}
		for (const rel of remote.keys()) {
			if (!local.has(rel)) extra.push(rel);
		}
		created.sort();
		updated.sort();
		extra.sort();
		return { created, updated, extra };
	}

	/* ---------------------------------------------------------- rsync 调用 */

	baseArgs() {
		const args = ['-a'];
		if (this.settings.checksum) args.push('-c');
		// iCloud 未下载的占位文件（.xxx.md.icloud）rsync 一律不碰：
		// 没有这条，镜像删除的 --delete 会把它们硬删——占位就是该文件在 iCloud 的本体表示，
		// 删掉等于连云端一起删，而且绕过回收目录（接收端 exclude 能挡住 --delete）
		args.push('--exclude=.*.icloud');
		for (const raw of this.settings.excludes || []) {
			const ex = String(raw || '').trim();
			if (ex) args.push(`--exclude=${ex}`);
		}
		return args;
	}

	execRsync(args) {
		const bin = (this.settings.rsyncPath || '').trim() || '/usr/bin/rsync';
		const timeoutMs = Math.max(30, Number(this.settings.timeoutSeconds) || 1800) * 1000;
		return new Promise((resolve) => {
			execFile(
				bin,
				args,
				{ maxBuffer: 128 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGTERM' },
				(err, stdout, stderr) => {
					let code = 0;
					if (err) {
						if (typeof err.code === 'number') code = err.code;
						else if (err.killed) code = 124;
						else if (err.code === 'ENOENT') code = 127;
						else code = 1;
					}
					resolve({
						code,
						stdout: stdout || '',
						stderr: stderr || '',
						killed: !!(err && err.killed),
						enoent: !!(err && err.code === 'ENOENT'),
						bin,
					});
				}
			);
		});
	}

	/**
	 * 把 iCloud 侧「本地已不存在」的文件搬进回收目录。
	 * 同一卷内是 rename，瞬间完成；失败再退化为复制 + 删除。
	 */
	moveExtrasToTrash(remoteRoot, extras) {
		const moved = [];
		const failed = [];
		const dir = path.join(remoteRoot, TRASH_DIR_NAME, stamp());
		for (const rel of extras) {
			const from = path.join(remoteRoot, rel);
			const to = path.join(dir, rel);
			let st;
			try {
				st = fs.lstatSync(from); // 悬空符号链接 existsSync 会返回 false，lstat 才检得出本体
			} catch (e) {
				continue;
			}
			try {
				if (!st) continue;
				if (st.isDirectory()) continue; // 目录交给 rsync --delete 清
				fs.mkdirSync(path.dirname(to), { recursive: true });
				try {
					fs.renameSync(from, to);
				} catch (e) {
					// 跨卷 rename 失败才走这里；符号链接要保持链接形态，不能跟随目标
					const st = fs.lstatSync(from);
					if (st.isSymbolicLink()) {
						fs.symlinkSync(fs.readlinkSync(from), to);
						fs.unlinkSync(from);
					} else {
						fs.copyFileSync(from, to);
						fs.unlinkSync(from);
					}
				}
				moved.push(rel);
			} catch (e) {
				failed.push(`${rel}（${e.message}）`);
			}
		}
		return { dir: moved.length ? dir : '', moved, failed };
	}

	/** 只清空目录本身（从深到浅），非空目录直接跳过 */
	pruneEmptyDirs(root, relDirs) {
		const removed = [];
		const sorted = (relDirs || [])
			.slice()
			.sort((a, b) => b.split('/').length - a.split('/').length);
		for (const rel of sorted) {
			try {
				fs.rmdirSync(path.join(root, rel));
				removed.push(rel);
			} catch (e) {
				/* 非空 / 已不存在，忽略 */
			}
		}
		return removed;
	}

	/** 把 root 下的单个路径（文件或整棵目录）搬进回收目录；batch 相同则进同一批次；成功返回目标路径 */
	/** 返回值：路径字符串=成功；null=路径不存在（无动作，不算失败）；''=真实失败 */
	movePathToTrash(root, rel, batch) {
		const from = path.join(root, rel);
		const to = path.join(root, TRASH_DIR_NAME, batch || stamp(), rel);
		try {
			fs.lstatSync(from); // 悬空符号链接 existsSync 会误判不存在，一律用 lstat
		} catch (e) {
			return null;
		}
		try {
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.renameSync(from, to);
			return to;
		} catch (e) {
			this.log(`⚠️ 无法把 ${rel} 移入回收目录：${e.message}`);
			return '';
		}
	}

	/** 把 tree 中 prefix（目录）前缀下的所有文件从 srcRoot 复制到 dstRoot */
	copyTreePrefix(srcRoot, dstRoot, tree, prefix) {
		let copied = 0;
		const failed = [];
		for (const [rel, ent] of tree) {
			if (ent.dir) continue;
			if (rel !== prefix && !rel.startsWith(prefix + '/')) continue;
			try {
				this.copyEntry(srcRoot, dstRoot, rel, ent);
				copied += 1;
			} catch (e) {
				failed.push(`${rel}（${e.message}）`);
			}
		}
		return { copied, failed };
	}

	/** 差异清单执行前重验：目标侧在扫描后被改动（类型变了 / mtime 变了 / 原本没有现在有了）就跳过 */
	planRowStale(item, row, paths) {
		try {
			const isPull = item.dir === 'pull';
			const target = path.join(isPull ? paths.localRoot : paths.remoteRoot, item.rel);
			if (!fs.existsSync(target)) return false; // 目标不存在：直接写
			const snap = isPull ? row.localEnt : row.remoteEnt;
			if (!snap) return true; // 扫描时没有、现在有了：扫描后新建的，不动它
			const st = fs.lstatSync(target);
			if (snap.link !== undefined) return !st.isSymbolicLink();
			if (st.isSymbolicLink() || snap.dir !== st.isDirectory()) return true;
			if (typeof snap.mtime === 'number' && Math.floor(st.mtimeMs / 1000) !== snap.mtime) return true;
			return false;
		} catch (e) {
			return false;
		}
	}

	/** 恢复执行前重验：本地目标在扫描后被改动就跳过，避免覆盖新改动 */
	restoreRowStale(rel, localEnt, isNew, localRoot) {
		try {
			const target = path.join(localRoot, rel);
			if (!fs.existsSync(target)) return false;
			if (isNew || !localEnt) return true; // 扫描时本地没有，现在有了
			if (localEnt.link !== undefined) return !fs.lstatSync(target).isSymbolicLink();
			const st = fs.lstatSync(target);
			if (st.isSymbolicLink() || st.isDirectory()) return true;
			return Math.floor(st.mtimeMs / 1000) !== localEnt.mtime;
		} catch (e) {
			return false;
		}
	}

	/** iCloud 未下载的占位文件：.foo.md.icloud（点前缀 + .icloud 后缀；普通文件 x.icloud 不算） */
	isPlaceholder(rel) {
		return /(^|\/)\.[^/]*\.icloud$/.test(rel);
	}

	/** 从目录树里剔除 iCloud 未下载的占位文件，返回 { tree, count, names, list } */
	stripPlaceholders(tree) {
		const kept = new Map();
		const names = new Set();
		const list = [];
		let count = 0;
		for (const [rel, ent] of tree) {
			if (!ent.dir && this.isPlaceholder(rel)) {
				const name = rel.replace(/(^|\/)\.([^/]+)\.icloud$/, '$1$2');
				count += 1;
				names.add(name); // sub/.foo.md.icloud 对应 sub/foo.md
				list.push({ rel, name });
				continue;
			}
			kept.set(rel, ent);
		}
		return { tree: kept, count, names, list };
	}

	/** 单文件（或符号链接）从 srcRoot 复制到 dstRoot，并保留源侧修改时间 */
	copyEntry(srcRoot, dstRoot, rel, ent) {
		const from = path.join(srcRoot, rel);
		const to = path.join(dstRoot, rel);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		if (ent && ent.link !== undefined) {
			try {
				fs.unlinkSync(to);
			} catch (e) {
				/* 目标不存在 */
			}
			fs.symlinkSync(ent.link, to);
			return;
		}
		// 目标若是符号链接，先摘掉再写：copyFileSync 会跟随链接，把内容写进它指向的外部文件
		try {
			if (fs.lstatSync(to).isSymbolicLink()) fs.unlinkSync(to);
		} catch (e) {
			/* 目标不存在 */
		}
		fs.copyFileSync(from, to);
		if (ent && typeof ent.mtime === 'number') {
			fs.utimesSync(to, ent.mtime, ent.mtime);
		}
	}

	copyFromBackup(remoteRoot, localRoot, rel, ent) {
		this.copyEntry(remoteRoot, localRoot, rel, ent);
	}

	/** 把比对结果拆成「文件 / 目录」两类相对路径（比对结果里目录带尾部 /） */
	splitEntries(tree, rels) {
		const files = [];
		const dirs = [];
		for (const raw of rels) {
			const rel = String(raw).replace(/\/+$/, '');
			const ent = tree.get(rel);
			if (ent && ent.dir) dirs.push(rel);
			else files.push(rel);
		}
		return { files, dirs };
	}

	countFiles(tree) {
		let n = 0;
		for (const ent of tree.values()) if (!ent.dir) n += 1;
		return n;
	}

	/* ---------------------------------------------------------- 主流程 */

	async runSync(mode = 'manual', opts = {}) {
		if (this.running) {
			new Notice('已有同步任务正在执行，请稍候…');
			return null;
		}
		const paths = this.resolvePaths(mode);
		if (!paths) return null;

		const dryOnly = !!opts.dryOnly;
		const started = Date.now();
		this.running = true;
		this.hashCache = new Map();

		const notice = new Notice(
			dryOnly ? '正在检查本地与 iCloud 备份的差异…' : '正在同步到 iCloud 备份…',
			0
		);

		const record = {
			time: timeText(),
			mode,
			dryOnly,
			ok: false,
			created: 0,
			updated: 0,
			extra: 0,
			trashed: 0,
			duration: 0,
			message: '',
			samples: [],
		};

		try {
			const src = withSlash(paths.localRoot);
			const dst = withSlash(paths.remoteRoot);

			/* 1) 扫描两边目录树做比对（两边都剔除 iCloud 占位形态，与 rsync 的 --exclude=.*.icloud 对齐） */
			const localScan = this.stripPlaceholders(this.walkTree(paths.localRoot));
			const local = localScan.tree;
			const remoteScan = this.stripPlaceholders(this.walkTree(paths.remoteRoot));
			const remote = remoteScan.tree;
			if (localScan.count) {
				this.log(`忽略本地 ${localScan.count} 个 iCloud 占位形态文件`);
			}
			if (remoteScan.count) {
				this.log(`忽略备份 ${remoteScan.count} 个未下载的 iCloud 占位文件`);
			}
			const diff = this.compareTrees(local, remote);

			record.created = diff.created.length;
			record.updated = diff.updated.length;
			record.extra = diff.extra.length;
			record.samples = []
				.concat(diff.created.map((f) => `新增  ${f}`))
				.concat(diff.updated.map((f) => `更新  ${f}`))
				.concat(diff.extra.map((f) => `多余  ${f}`))
				.slice(0, SAMPLE_LIMIT);

			this.log(
				`扫描完成（本地 ${local.size} 项 / iCloud ${remote.size} 项）：` +
					`新增 ${record.created} · 更新 ${record.updated} · iCloud 多余 ${record.extra}`
			);

			/* 镜像删除安全闸：本地扫不到任何文件时中止，防止配置错误把整份备份搬空（与「清理」同一守卫） */
			if (this.settings.mirrorDelete && record.extra > 0 && this.countFiles(local) === 0) {
				throw new Error(
					`本地 vault 没有扫到任何文件，而备份里有 ${record.extra} 个多余项；` +
						'为防止搬空备份，本次已中止，未做任何改动。请检查本地目录配置。'
				);
			}

			const hasDiff = record.created + record.updated > 0;

			/* 2) 一致则直接结束 */
			if (!hasDiff && !(this.settings.mirrorDelete && record.extra > 0)) {
				record.ok = true;
				record.message = '本地内容与 iCloud 备份一致，无需写入。';
				this.log(record.message);
				this.finish(record, started, notice, mode);
				return record;
			}

			if (dryOnly) {
				record.ok = true;
				record.message = '仅检查模式，未写入任何文件。';
				this.log(record.message);
				this.finish(record, started, notice, mode);
				return record;
			}

			/* 3) 真正执行同步 */
			const args = this.baseArgs();
			if (this.settings.mirrorDelete) {
				if (diff.extra.length) {
					// 与「按备份恢复」镜像对称：本地被 iCloud 驱逐成占位的文件，其备份真身不算冗余
					const extraRels = diff.extra.filter((rel) => !localScan.names.has(rel));
					const evictedLocal = diff.extra.length - extraRels.length;
					if (evictedLocal) {
						this.log(`镜像删除豁免 ${evictedLocal} 个（本地未下载、呈占位形态）`);
						// 豁免只是不搬进回收，--delete 仍会删——同样逐个加 exclude 保护到下一轮
						for (const rel of diff.extra.filter((r) => localScan.names.has(r))) {
							args.push(`--exclude=${rel}`);
						}
					}
					const trashed = this.moveExtrasToTrash(paths.remoteRoot, extraRels);
					record.trashed = trashed.moved.length;
					this.log(`已移入回收目录 ${trashed.moved.length} 项 → ${trashed.dir || '(无)'}`);
					if (trashed.failed.length) {
						this.log(`⚠️ 有 ${trashed.failed.length} 项未能移入回收目录：${trashed.failed[0]}`);
						// 没搬走的留在原地，--delete 会连它们一起硬删——逐个加 exclude 保护到下一轮
						for (const f of trashed.failed) {
							const rel = f.split('（')[0];
							args.push(`--exclude=${rel}`);
						}
					}
				}
				args.push('--delete');
			}
			/* 类型冲突（同一路径一边文件一边目录）预处理：备份侧先整体搬进回收，
			   否则「本地文件压备份目录」会让 rsync 报 unlinkat 失败，直接覆盖也不进回收 */
			const conflictRels = diff.updated
				.map((rel) => rel.replace(/\/+$/, ''))
				.filter((rel) => {
					const l = local.get(rel);
					const r = remote.get(rel);
					return !!l && !!r && !!l.dir !== !!r.dir;
				});
			if (conflictRels.length) {
				const batch = stamp();
				let moved = 0;
				for (const rel of conflictRels) {
					if (this.movePathToTrash(paths.remoteRoot, rel, batch)) moved += 1;
				}
				record.trashed += moved;
				this.log(
					`类型冲突预处理：备份侧 ${moved} 个路径已移入回收目录（${conflictRels.slice(0, 3).join('、')}）`
				);
			}

			args.push(src, dst);

			this.log(`执行同步：${args.join(' ')}`);
			const run = await this.execRsync(args);

			if (run.enoent) {
				throw new Error(`找不到 rsync 可执行文件：${run.bin}`);
			}
			if (run.code !== 0) {
				const detail = firstLine(run.stderr) || firstLine(run.stdout) || `退出码 ${run.code}`;
				throw new Error(`rsync 同步失败：${detail}`);
			}
			if (run.stderr && run.stderr.trim()) {
				this.log(`rsync 警告：${firstLine(run.stderr)}`);
			}

			/* 同步后清理备份侧「真身已存在」的 iCloud 占位残留，避免同名文件与占位长期并存 */
			if (remoteScan.list.length) {
				const batch = stamp();
				let cleaned = 0;
				for (const ph of remoteScan.list) {
					if (!fs.existsSync(path.join(paths.remoteRoot, ph.name))) continue;
					if (this.movePathToTrash(paths.remoteRoot, ph.rel, batch)) cleaned += 1;
				}
				if (cleaned) {
					record.trashed += cleaned;
					this.log(`备份侧 ${cleaned} 个 iCloud 占位残留（真身已存在）已移入回收目录`);
				}
			}

			record.ok = true;
			record.message = '同步完成。';
			this.finish(record, started, notice, mode);
			return record;
		} catch (err) {
			record.ok = false;
			record.message = (err && err.message) || String(err);
			this.log(`❌ ${record.message}`);
			this.finish(record, started, notice, mode);
			return record;
		} finally {
			this.running = false;
		}
	}

	/* ------------------------------------------------- 反向操作：恢复 / 清理 */

	/**
	 * 按 iCloud 备份恢复本地 vault（iCloud → 本地）。
	 * 默认只「写入/覆盖」，不删除本地独有文件；勾选后才把它们移入本地回收目录。
	 */
	/**
	 * 按 iCloud 备份恢复本地 vault（iCloud → 本地）。
	 * 确认框里逐项勾选要恢复的文件；没勾选的一律不动。
	 * 默认不删除本地独有文件，勾选「同时把本地独有文件移入回收目录」后才移走。
	 */
	async runRestore() {
		if (this.running) {
			new Notice('已有任务正在执行，请稍候…');
			return null;
		}
		const paths = this.resolvePaths('manual', { strictRoot: true });
		if (!paths) return null;

		const started = Date.now();
		const record = {
			time: timeText(),
			ok: false,
			created: 0,
			updated: 0,
			trashed: 0,
			dirs: 0,
			failed: 0,
			skipped: 0,
			duration: 0,
			message: '',
			samples: [],
		};

		this.running = true;
		this.hashCache = new Map();
		try {
			/* 1) 扫描：备份为源，本地为目标（两边都剔除 iCloud 占位形态） */
			const local = this.stripPlaceholders(this.walkTree(paths.localRoot)).tree;
			const remoteScan = this.stripPlaceholders(this.walkTree(paths.remoteRoot));
			const remote = remoteScan.tree;
			const placeholderCount = remoteScan.count;
			if (placeholderCount) {
				this.log(`忽略 ${placeholderCount} 个未下载的 iCloud 占位文件（*.icloud）`);
			}

			const remoteFiles = this.countFiles(remote);
			if (!remoteFiles) {
				this.log('❌ 恢复中止：备份目录里没有可恢复的文件');
				new Notice('❌ 恢复中止：备份目录里没有可恢复的文件（是否 iCloud 尚未下载完成？）', 12000);
				return null;
			}

			const diff = this.compareTrees(local, remote);
			// 注意方向：compareTrees 的 created/updated 是「本地 → 备份」口径，
			// 恢复（备份 → 本地）时，备份独有的才是新增、两边都有但不同的才是覆盖。
			const incoming = this.splitEntries(remote, diff.extra);
			// 备份里被 iCloud 驱逐成占位（.foo.md.icloud）的文件，其本地同名版本不算「本地独有」，
			// 否则勾选「完全一致」会把活笔记搬进回收站
			const evicted = [...remoteScan.names].filter((n) => local.has(n)).length;
			const localExtra = this.splitEntries(
				local,
				diff.created.filter((rel) => !remoteScan.names.has(rel))
			);
			const localFiles = this.countFiles(local);
			// 类型冲突（同一路径一边文件一边目录）：单独列出，恢复时本地该路径整体进回收再复制备份侧
			const conflicts = diff.updated
				.map((rel) => rel.replace(/\/+$/, ''))
				.filter((rel) => {
					const l = local.get(rel);
					const r = remote.get(rel);
					return !!l && !!r && !!l.dir !== !!r.dir;
				});
			const conflictSet = new Set(conflicts);
			const overwriteFiles = diff.updated
				.map((rel) => rel.replace(/\/+$/, ''))
				.filter((rel) => !conflictSet.has(rel) && !(remote.get(rel) || {}).dir);
			const createdSet = new Set(incoming.files);

			const items = incoming.files
				.map((rel) => ({ path: rel, note: '新增' }))
				.concat(overwriteFiles.map((rel) => ({ path: rel, note: '覆盖' })))
				.concat(conflicts.map((rel) => ({ path: rel, note: '类型冲突' })));
			items.sort((a, b) => a.path.localeCompare(b.path, 'zh'));

			// 本地版本比备份新的文件：恢复会把它们退回旧内容，必须显式提示
			let newerLocal = 0;
			for (const rel of overwriteFiles) {
				const l = local.get(rel);
				const r = remote.get(rel);
				if (l && r && l.mtime > r.mtime) newerLocal += 1;
			}

			/* 2) 确认 + 逐项勾选 */
			const warns = [];
			if (placeholderCount) {
				warns.push(
					`备份里有 ${placeholderCount} 个文件尚未下载到本机（.icloud 占位），本次会跳过；` +
						`需要它们时请先在 Finder 里打开备份目录并等待 iCloud 下载完成。`
				);
			}
			if (localFiles && remoteFiles < localFiles / 2) {
				warns.push(
					`备份文件数（${remoteFiles}）不到本地（${localFiles}）的一半，这份备份可能不完整，请先确认再继续。`
				);
			}
			if (newerLocal) {
				warns.push(
					`其中 ${newerLocal} 个文件本地版本比备份新，恢复会把它们退回备份里的旧内容；` +
						`如果这些是最近的改动，请改用「立即同步」把本地推到备份，而不是恢复。`
				);
			}
			if (localExtra.files.length) {
				warns.push(`本地有 ${localExtra.files.length} 个文件在备份里不存在，默认保留不动。`);
			}
			if (evicted) {
				warns.push(
					`另有 ${evicted} 个文件在备份里尚未下载（.icloud 占位），无法比较；` +
						'它们不计入「本地独有」，勾选「完全一致」也不会被移走。'
				);
			}

			const answer = await new ConfirmModal(this.app, {
				title: '按备份恢复本仓库',
				intro:
					'勾选要恢复的文件（默认全不选）。被勾选的文件会用备份里的版本覆盖本地，无法撤销；' +
					'恢复完成后需要重载 Obsidian（Cmd+R）才能看到变化。',
				rows: [
					['本地 vault', paths.localRoot],
					['恢复来源', paths.remoteRoot],
					['可恢复', `新增 ${incoming.files.length} 个文件 · 覆盖 ${overwriteFiles.length} 个文件`],
					['类型冲突', conflicts.length ? `${conflicts.length} 个（本地该路径整体进回收，再复制备份侧）` : '无'],
					[
						'本地独有',
						localExtra.files.length ? `${localExtra.files.length} 个文件（默认保留）` : '无',
					],
				],
				warns,
				items,
				itemsDefaultChecked: false,
				emptyItemsText: '本地内容已经和备份一致，没有可恢复的文件。',
				checkboxLabel: '同时把本地独有文件移入 .vault-sync-trash 回收目录（让本地与备份完全一致）',
				checkboxDefault: false,
				confirmText: '恢复所选',
				danger: true,
			}).ask();

			if (!answer.ok) {
				this.log('已取消「按备份恢复本仓库」');
				new Notice('已取消恢复，未改动任何文件');
				return null;
			}

			const picked = (answer.selected || []).filter((rel) => remote.has(rel));
			if (!picked.length && !answer.checked) {
				new Notice('没有勾选任何文件，未做任何改动');
				return null;
			}

			/* 3) 可选：先把本地独有文件移走 */
			if (answer.checked && localExtra.files.length) {
				const trashed = this.moveExtrasToTrash(paths.localRoot, localExtra.files);
				record.trashed = trashed.moved.length;
				this.log(`本地独有文件移入回收目录 ${trashed.moved.length} 项 → ${trashed.dir || '(无)'}`);
				if (trashed.failed.length) {
					this.log(`⚠️ 有 ${trashed.failed.length} 项未能移入回收目录：${trashed.failed[0]}`);
				}
			}
			if (answer.checked) {
				record.dirs = this.pruneEmptyDirs(paths.localRoot, localExtra.dirs).length;
			}

			/* 4) 逐项写回本地（保留备份侧的修改时间，避免下次同步又当成差异） */
			const notice = picked.length ? new Notice(`正在恢复 0/${picked.length}…`, 0) : null;
			const failed = [];
			const skipped = [];
			try {
				for (let i = 0; i < picked.length; i += 1) {
					const rel = picked[i];
					try {
						if (conflictSet.has(rel)) {
							// 类型冲突：本地该路径整体搬进回收，再把备份侧该前缀下的文件复制过来
							const l = local.get(rel);
							let st = null;
							try {
								st = fs.lstatSync(path.join(paths.localRoot, rel));
							} catch (e) {
								/* 扫描后本地该路径没了 */
							}
							if (!st || !!l.dir !== st.isDirectory()) {
								skipped.push(rel);
							} else {
								const movedTrash = this.movePathToTrash(paths.localRoot, rel, stamp());
								if (movedTrash === '') {
									throw new Error('本地路径未能移入回收目录');
								}
								const res = this.copyTreePrefix(paths.remoteRoot, paths.localRoot, remote, rel);
								record.created += res.copied;
								failed.push(...res.failed);
							}
						} else if (this.restoreRowStale(rel, local.get(rel), createdSet.has(rel), paths.localRoot)) {
							skipped.push(rel);
						} else {
							this.copyFromBackup(paths.remoteRoot, paths.localRoot, rel, remote.get(rel));
							if (createdSet.has(rel)) record.created += 1;
							else record.updated += 1;
						}
					} catch (e) {
						if (e && (e.code === 'EEXIST' || e.code === 'ENOTDIR')) {
							// 父路径被同名冲突文件挡着：属「要先选父冲突行」的情形，按跳过算
							skipped.push(rel);
						} else {
							failed.push(`${rel}（${e.message}）`);
						}
					}
					if (notice && typeof notice.setMessage === 'function' && i % 25 === 0) {
						notice.setMessage(`正在恢复 ${i + 1}/${picked.length}…`);
					}
				}
			} finally {
				if (notice) {
					try {
						notice.hide();
					} catch (e) {
						/* ignore */
					}
				}
			}

			record.failed = failed.length;
			record.skipped = skipped.length;
			record.ok = failed.length === 0;
			record.samples = picked.slice(0, SAMPLE_LIMIT);
			record.duration = Math.round((Date.now() - started) / 100) / 10;
			record.message = record.ok
				? '已按备份恢复所选文件。'
				: `已恢复 ${record.created + record.updated} 项，${failed.length} 项失败（详见日志）。`;
			this.state.lastRestore = record;
			await this.saveAll();

			this.log(
				`恢复完成：新增 ${record.created} · 覆盖 ${record.updated} · 本地独有移除 ${record.trashed} · ` +
					`空目录移除 ${record.dirs} · 失败 ${record.failed} · 用时 ${record.duration}s`
			);
			if (failed.length) this.log(`⚠️ 恢复失败样例：${failed[0]}`);

			const body =
				`新增 ${record.created} · 覆盖 ${record.updated}` +
				(record.trashed ? ` · 移入回收 ${record.trashed}` : '') +
				(record.skipped ? ` · 跳过 ${record.skipped}（扫描后有变动）` : '') +
				(record.failed ? ` · 失败 ${record.failed}` : '') +
				` · 用时 ${record.duration}s`;

			if (!record.ok) {
				new Notice(`⚠️ 恢复有失败项\n${body}\n详见日志`, 15000);
			} else if (record.created + record.updated === 0) {
				const zeroText = record.skipped
					? `ℹ️ 勾选的 ${record.skipped} 项在扫描后都发生了变动，已全部跳过（未做任何改动）`
					: record.trashed
						? `✅ 已把 ${record.trashed} 个本地独有文件移入回收目录`
						: '✅ 已确认：本地内容与备份一致';
				new Notice(zeroText, 8000);
			} else {
				new Notice(`✅ 已按备份恢复\n${body}\n请重载 Obsidian（Cmd+R）刷新界面`, 12000);
			}
			return record;
		} catch (err) {
			record.ok = false;
			record.message = (err && err.message) || String(err);
			record.duration = Math.round((Date.now() - started) / 100) / 10;
			this.state.lastRestore = record;
			await this.saveAll();
			this.log(`❌ 恢复失败：${record.message}`);
			new Notice(`❌ 恢复失败\n${record.message}`, 15000);
			return record;
		} finally {
			this.running = false;
		}
	}

	/**
	 * 按本地 vault 的现状清理 iCloud 备份里的冗余项（备份里有、本地已没有）。
	 * 只搬进备份目录下的回收目录，不做真正删除。
	 */
	/**
	 * 按本地 vault 的现状清理 iCloud 备份里的冗余项（备份里有、本地已没有）。
	 * 确认框里逐项勾选要清理的文件；只搬进备份目录下的回收目录，不做真正删除。
	 */
	async runCleanRemote() {
		if (this.running) {
			new Notice('已有任务正在执行，请稍候…');
			return null;
		}
		const paths = this.resolvePaths('manual', { strictRoot: true });
		if (!paths) return null;

		const started = Date.now();
		const record = {
			time: timeText(),
			ok: false,
			removed: 0,
			dirs: 0,
			failed: 0,
			skipped: 0,
			duration: 0,
			message: '',
			dir: '',
			samples: [],
		};

		this.running = true;
		this.hashCache = new Map();
		try {
			const local = this.stripPlaceholders(this.walkTree(paths.localRoot)).tree;
			const remoteScan = this.stripPlaceholders(this.walkTree(paths.remoteRoot));
			const remote = remoteScan.tree;
			const localFiles = this.countFiles(local);

			// 本地看起来是空的（例如挂错盘、iCloud 同步未完成）时拒绝清理，避免把整份备份搬走
			if (!localFiles) {
				this.log('❌ 清理中止：本地 vault 里没有任何文件');
				new Notice('❌ 清理中止：本地 vault 里没有扫到任何文件，为安全起见不做清理', 12000);
				return null;
			}

			const diff = this.compareTrees(local, remote);
			const extra = this.splitEntries(remote, diff.extra);
			if (!extra.files.length) {
				record.ok = true;
				record.duration = Math.round((Date.now() - started) / 100) / 10;
				if (extra.dirs.length) {
					// 只剩空目录：不承载数据，直接移除并记录
					const pruned = this.pruneEmptyDirs(paths.remoteRoot, extra.dirs);
					record.dirs = pruned.length;
					record.samples = pruned.slice(0, SAMPLE_LIMIT);
					record.message = `没有冗余文件；移除了 ${pruned.length} 个备份侧冗余空目录。`;
					this.log(`清理：无冗余文件，移除空目录 ${pruned.length} 个`);
					new Notice(`✅ 没有冗余文件；顺手移除了 ${pruned.length} 个空目录`, 8000);
				} else {
					record.message = '备份与本地一致，没有冗余文件。';
					this.log('清理检查：备份没有冗余文件');
					new Notice('✅ 备份与本地一致，没有冗余文件', 6000);
				}
				this.state.lastClean = record;
				await this.saveAll();
				return record;
			}

			const items = extra.files.map((rel) => ({ path: rel })).sort((a, b) => a.path.localeCompare(b.path, 'zh'));

			const answer = await new ConfirmModal(this.app, {
				title: '按本仓库情况清理备份冗余文件',
				intro:
					'勾选要清理的文件（默认全不选）。它们只存在于 iCloud 备份、本地 vault 已没有，' +
					`会被移入备份目录下的 ${TRASH_DIR_NAME}/<时间戳>/，可随时找回，不做真正删除。`,
				rows: [
					['备份目录', paths.remoteRoot],
					['冗余文件', `${extra.files.length} 个`],
					['冗余目录', `${extra.dirs.length} 个（清空后一并移除）`],
					['本地 vault', `${localFiles} 个文件`],
				],
				warns: [
					'手机 / iPad 上新建、还没同步回本地的笔记也算「冗余」，会被一起移走；清理前请确认那台设备已同步完成。',
				],
				items,
				itemsDefaultChecked: false,
				emptyItemsText: '备份里没有冗余文件。',
				confirmText: '移入回收目录',
				danger: true,
			}).ask();

			if (!answer.ok) {
				this.log('已取消「清理备份冗余文件」');
				new Notice('已取消清理，未改动任何文件');
				return null;
			}

			const picked = (answer.selected || []).filter((rel) => remote.has(rel));
			if (!picked.length) {
				new Notice('没有勾选任何文件，未做任何改动');
				return null;
			}

			const notice = new Notice('正在清理备份冗余文件…', 0);
			let trashed = { dir: '', moved: [], failed: [] };
			try {
				trashed = this.moveExtrasToTrash(paths.remoteRoot, picked);
			} finally {
				try {
					notice.hide();
				} catch (e) {
					/* ignore */
				}
			}

			record.removed = trashed.moved.length;
			record.failed = trashed.failed.length;
			record.skipped = extra.files.length - picked.length;
			record.dir = trashed.dir;
			record.dirs = this.pruneEmptyDirs(paths.remoteRoot, extra.dirs).length;
			record.ok = trashed.failed.length === 0;
			record.message = record.ok
				? '已清理所选备份冗余文件。'
				: `已清理 ${record.removed} 项，${record.failed} 项失败（详见日志）。`;
			record.samples = trashed.moved.slice(0, SAMPLE_LIMIT);
			record.duration = Math.round((Date.now() - started) / 100) / 10;

			this.state.lastClean = record;
			await this.saveAll();
			this.log(
				`清理完成：移入回收目录 ${record.removed} 个文件 / ${record.dirs} 个空目录 → ` +
					`${record.dir || '(无)'} · 跳过 ${record.skipped} · 失败 ${record.failed} · 用时 ${record.duration}s`
			);

			if (!record.ok) {
				new Notice(`⚠️ ${record.message}`, 12000);
			} else {
				new Notice(
					`✅ 已清理备份冗余\n移走 ${record.removed} 个文件 · ${record.dirs} 个空目录` +
						(record.skipped ? ` · 跳过 ${record.skipped}` : '') +
						(record.dir ? `\n回收目录：${record.dir}` : '') +
						`\n用时 ${record.duration}s`,
					12000
				);
			}
			return record;
		} catch (err) {
			record.ok = false;
			record.message = (err && err.message) || String(err);
			record.duration = Math.round((Date.now() - started) / 100) / 10;
			this.state.lastClean = record;
			await this.saveAll();
			this.log(`❌ 清理失败：${record.message}`);
			new Notice(`❌ 清理失败\n${record.message}`, 15000);
			return record;
		} finally {
			this.running = false;
		}
	}

	/**
	 * 「仅检查差异」：扫描两边差异，弹框逐项选择「备份」或「还原」，
	 * 确认后才逐文件写盘（不删除任何文件，删除走「清理备份冗余」）。
	 */
	async openDiffPlan() {
		if (this.running) {
			new Notice('已有任务正在执行，请稍候…');
			return null;
		}
		const paths = this.resolvePaths('manual', { strictRoot: true });
		if (!paths) return null;

		const scanNotice = new Notice('正在比对本地与备份…', 0);
		let rows = [];
		const byRel = new Map();
		const dirStats = { localOnly: 0, remoteOnly: 0 };
		let scanTrees = null;
		let handedOff = false;
		this.running = true; // 从扫描到弹框确认全程占用任务锁，避免勾选计划被并发任务挤掉
		try {
			try {
				this.hashCache = new Map(); // 与其余入口一致：每次扫描重新计算内容哈希
				const local = this.stripPlaceholders(this.walkTree(paths.localRoot)).tree;
				const remoteScan = this.stripPlaceholders(this.walkTree(paths.remoteRoot));
				const remote = remoteScan.tree;
				scanTrees = { local, remote };
				const diff = this.compareTrees(local, remote);

				const localOnlyAll = this.splitEntries(local, diff.created);
				const remoteOnlyAll = this.splitEntries(remote, diff.extra);
				const localOnly = localOnlyAll.files;
				const remoteOnly = remoteOnlyAll.files;
				dirStats.localOnly = localOnlyAll.dirs.length;
				dirStats.remoteOnly = remoteOnlyAll.dirs.length;
				const both = diff.updated
					.map((rel) => rel.replace(/\/+$/, ''))
					.filter((rel) => {
						const l = local.get(rel);
						const r = remote.get(rel);
						return !!l && !!r && !l.dir && !r.dir;
					});
				const conflicts = diff.updated
					.map((rel) => rel.replace(/\/+$/, ''))
					.filter((rel) => {
						const l = local.get(rel);
						const r = remote.get(rel);
						return !!l && !!r && !!l.dir !== !!r.dir;
					});

				rows = localOnly
					.map((rel) => ({ rel, kind: 'local-only', dir: 'push', localEnt: local.get(rel), remoteEnt: null }))
					.concat(
						both.map((rel) => ({
							rel,
							kind: 'both',
							dir: 'push',
							localEnt: local.get(rel),
							remoteEnt: remote.get(rel),
						}))
					)
					.concat(
						conflicts.map((rel) => ({
							rel,
							kind: 'conflict',
							dir: 'push',
							localEnt: local.get(rel),
							remoteEnt: remote.get(rel),
						}))
					)
					.concat(
						remoteOnly.map((rel) => ({
							rel,
							kind: 'remote-only',
							dir: 'pull',
							localEnt: null,
							remoteEnt: remote.get(rel),
						}))
					);
				rows.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
				for (const r of rows) byRel.set(r.rel, r);

				this.log(
					`差异扫描：本地独有 ${localOnly.length} · 两边不同 ${both.length} · 备份独有 ${remoteOnly.length} · 类型冲突 ${conflicts.length}`
				);
			} finally {
				try {
					scanNotice.hide();
				} catch (e) {
					/* ignore */
				}
			}

		if (!rows.length) {
			if (dirStats.localOnly + dirStats.remoteOnly) {
				new Notice(
					`两边文件一致，但有 ${dirStats.localOnly + dirStats.remoteOnly} 个空目录差异（本地独有 ${dirStats.localOnly} · 备份独有 ${dirStats.remoteOnly}）；` +
						'「立即同步」会把本地独有的补到备份；备份独有的请用「清理备份冗余」移除',
					10000
				);
				this.log(`差异扫描：文件一致，空目录差异 ${dirStats.localOnly + dirStats.remoteOnly} 个`);
			} else {
				new Notice('✅ 本地与备份一致，没有差异', 6000);
				this.log('差异扫描：两边一致');
			}
			return null;
		}

		const count = { localOnly: 0, both: 0, remoteOnly: 0, conflict: 0, newerLocal: 0 };
		for (const r of rows) {
			if (r.kind === 'local-only') count.localOnly += 1;
			else if (r.kind === 'both') count.both += 1;
			else if (r.kind === 'conflict') count.conflict += 1;
			else count.remoteOnly += 1;
			if (
				r.kind === 'both' &&
				r.localEnt &&
				r.remoteEnt &&
				typeof r.localEnt.mtime === 'number' &&
				r.localEnt.mtime > r.remoteEnt.mtime
			) {
				count.newerLocal += 1;
			}
		}

		const answer = await new DiffPlanModal(this.app, rows, {
			rows: [
				['本地 vault', paths.localRoot],
				['备份目录', paths.remoteRoot],
				['本地独有', `${count.localOnly} 个（只能备份）`],
				['两边不同', `${count.both} 个（可备份或还原）`],
				['备份独有', `${count.remoteOnly} 个（只能还原）`],
			]
				.concat(
					count.conflict
						? [['类型冲突', `${count.conflict} 个（勾选后目标侧整路径先进回收，再复制源侧整目录）`]]
						: []
				)
				.concat(
				dirStats.localOnly + dirStats.remoteOnly
					? [
							[
								'空目录差异',
								`${dirStats.localOnly + dirStats.remoteOnly} 个（不在下方清单；本地独有的由「立即同步」补到备份，备份独有的请用「清理备份冗余」移除）`,
							],
						]
					: []
			),
			warns: [
				'「备份」会用本地版本覆盖备份，「还原」会用备份版本覆盖本地；两个方向都会覆盖对方那一侧的同名文件。',
				'扫描后又被改动过的文件会在执行时自动跳过，不会覆盖新改动。',
			].concat(
				count.newerLocal
					? [`其中 ${count.newerLocal} 个文件本地版本比备份新；选「还原」会把它们退回旧版。`]
					: []
			),
		}).ask();

		if (!answer.ok) {
			this.log('已取消差异处理');
			new Notice('已取消，未改动任何文件');
			return null;
		}
		if (!answer.plan.length) {
			new Notice('没有勾选任何条目，未做任何改动');
			return null;
		}
		handedOff = true;
		return await this.applyPlan(paths, answer.plan, byRel, scanTrees, { skipGuard: true });
		} finally {
			if (!handedOff) this.running = false;
		}
	}

	/** 按选定方向逐个文件写盘；opts.skipGuard = 由 openDiffPlan 移交任务锁（已持有，不再重复检查） */
	async applyPlan(paths, plan, byRel, trees, opts = {}) {
		const skipGuard = !!(opts && opts.skipGuard);
		if (!skipGuard) {
			if (this.running) {
				new Notice('已有任务正在执行，请稍候…');
				return null;
			}
			this.running = true;
		}
		const started = Date.now();
		try {
			const record = {
			time: timeText(),
			ok: false,
			pushed: 0,
			pulled: 0,
			failed: 0,
			skipped: 0,
			duration: 0,
			message: '',
			samples: [],
			};

			const notice = new Notice(`正在处理 0/${plan.length}…`, 0);
			const failed = [];
			const skipped = [];
			try {
			for (let i = 0; i < plan.length; i += 1) {
				const item = plan[i];
				const row = byRel.get(item.rel);
				if (!row) continue;
				try {
					if (this.planRowStale(item, row, paths)) {
						skipped.push(item.rel);
					} else if (row.kind === 'conflict') {
						// 类型冲突：目标侧整路径搬进回收，再把源侧该前缀下的文件复制过去
						const isPull = item.dir === 'pull';
						const targetRoot = isPull ? paths.localRoot : paths.remoteRoot;
						const movedTrash = this.movePathToTrash(targetRoot, item.rel, stamp());
						// null = 扫描后目标已消失，没东西可搬，直接继续复制（与重验「不存在直接写」同口径）
						if (movedTrash === '') {
							throw new Error('目标侧路径未能移入回收目录');
						}
						const res = isPull
							? this.copyTreePrefix(paths.remoteRoot, paths.localRoot, trees.remote, item.rel)
							: this.copyTreePrefix(paths.localRoot, paths.remoteRoot, trees.local, item.rel);
						if (isPull) record.pulled += res.copied;
						else record.pushed += res.copied;
						failed.push(...res.failed);
					} else if (item.dir === 'pull') {
						if (!row.remoteEnt) throw new Error('备份里没有这个文件');
						this.copyEntry(paths.remoteRoot, paths.localRoot, item.rel, row.remoteEnt);
						record.pulled += 1;
					} else {
						if (!row.localEnt) throw new Error('本地没有这个文件');
						this.copyEntry(paths.localRoot, paths.remoteRoot, item.rel, row.localEnt);
						record.pushed += 1;
					}
				} catch (e) {
					if (e && (e.code === 'EEXIST' || e.code === 'ENOTDIR')) {
						skipped.push(item.rel);
					} else {
						failed.push(`${item.rel}（${e.message}）`);
					}
				}
				if (typeof notice.setMessage === 'function' && i % 50 === 0) {
					notice.setMessage(`正在处理 ${i + 1}/${plan.length}…`);
				}
			}
			record.failed = failed.length;
			record.skipped = skipped.length;
			record.ok = failed.length === 0;
			record.message = record.ok
				? '已按所选方向处理差异。'
				: `已处理 ${record.pushed + record.pulled} 项，${failed.length} 项失败（详见日志）。`;
			record.samples = plan.map((p) => `${p.dir === 'pull' ? '还原' : '备份'}  ${p.rel}`).slice(0, SAMPLE_LIMIT);
			if (failed.length) this.log(`⚠️ 差异处理失败样例：${failed[0]}`);
			} finally {
			try {
				notice.hide();
			} catch (e) {
				/* ignore */
			}
			}

			record.duration = Math.round((Date.now() - started) / 100) / 10;
			this.state.lastPlan = record;
			await this.saveAll();
			this.log(
			`差异处理完成：备份 ${record.pushed} · 还原 ${record.pulled} · 跳过 ${record.skipped} · 失败 ${record.failed} · 用时 ${record.duration}s`
			);

			const body =
			`备份 ${record.pushed} · 还原 ${record.pulled}` +
			(record.skipped ? ` · 跳过 ${record.skipped}（扫描后有变动）` : '') +
			(record.failed ? ` · 失败 ${record.failed}` : '');
			if (!record.ok) {
			new Notice(`⚠️ 差异处理有失败项\n${body}\n详见日志`, 15000);
			} else {
			new Notice(`✅ 差异处理完成\n${body}\n用时 ${record.duration}s（还原的文件需 Cmd+R 重载后可见）`, 10000);
			}
			return record;
		} finally {
			this.running = false; // 构造阶段异常也收口（配合方法开头的 try）
		}
	}

	finish(record, started, notice, mode) {
		record.duration = Math.round((Date.now() - started) / 100) / 10;
		this.state.lastRun = record;
		if (mode === 'auto' && record.ok) {
			this.state.lastAutoDate = dateKey();
		}
		this.saveAll().catch((e) => this.log(`⚠️ 状态写入失败：${e && e.message ? e.message : e}`));

		try {
			notice.hide();
		} catch (e) {
			/* ignore */
		}

		const head = record.ok ? '✅ iCloud 备份同步' : '❌ iCloud 备份同步失败';
		const body =
			`新增 ${record.created} · 更新 ${record.updated}` +
			(record.extra
				? ` · iCloud 多余 ${record.extra}` +
				  (record.trashed ? `（已移入回收目录 ${record.trashed}）` : '（按设置保留）')
				: '') +
			` · 用时 ${record.duration}s`;

		const didWork = record.created + record.updated + record.trashed > 0;

		let text;
		if (!record.ok) {
			text = `${head}\n${record.message}`;
		} else if (!didWork && !record.dryOnly) {
			text = `✅ 本地与 iCloud 备份一致，无需同步\n${body}`;
		} else if (record.dryOnly) {
			text = `🔍 检查完成\n${body}`;
		} else {
			text = `${head}\n${body}`;
		}

		const show =
			!record.ok ||
			record.dryOnly ||
			(didWork ? this.settings.notifyOnSuccess : this.settings.notifyOnNoChange);

		if (show) new Notice(text, record.ok ? 6000 : 15000);
	}

	showLastResult() {
		new LastRunModal(this.app, this.state, this.logPath).open();
	}
}

/* ------------------------------------------------------------------ 确认弹窗 */

/**
 * 恢复 / 清理这类会改写文件的操作，统一先弹确认框。
 * ask() 返回 Promise<{ ok, checked }>；点取消、按 Esc、点右上角关闭都算取消。
 */
class ConfirmModal extends Modal {
	constructor(app, opts) {
		super(app);
		this.opts = opts || {};
		this.checked = !!this.opts.checkboxDefault;
		this.items = Array.isArray(this.opts.items) ? this.opts.items.slice() : null;
		this.selected = new Set();
		if (this.items && this.opts.itemsDefaultChecked) {
			for (const it of this.items) this.selected.add(it.path);
		}
		this.filterText = '';
		this.shown = 0;
		this.moreEl = null;
		this.listEl = null;
		this.countEl = null;
		this.confirmBtn = null;
		this.promise = new Promise((resolve) => {
			this._resolve = resolve;
		});
	}

	ask() {
		this.open();
		return this.promise;
	}

	settle(ok) {
		const fn = this._resolve;
		this._resolve = () => {};
		if (fn) fn({ ok, checked: this.checked, selected: Array.from(this.selected || []) });
	}

	onOpen() {
		const { contentEl } = this;
		const o = this.opts;
		contentEl.addClass('vault-icloud-sync-modal');
		contentEl.createEl('h2', { text: o.title || '确认操作' });

		if (o.intro) contentEl.createEl('p', { text: o.intro, cls: 'vault-icloud-sync-kv' });

		for (const row of o.rows || []) {
			if (!row) continue;
			const p = contentEl.createEl('p', { cls: 'vault-icloud-sync-kv' });
			p.createEl('strong', { text: `${row[0]}：` });
			p.createSpan({ text: String(row[1]) });
		}

		for (const w of o.warns || []) {
			contentEl.createEl('p', { text: w, cls: 'vault-icloud-sync-warn' });
		}

		if (this.items) this.renderSelector(contentEl);

		if (o.checkboxLabel) {
			new Setting(contentEl).setName(o.checkboxLabel).addToggle((t) =>
				t.setValue(this.checked).onChange((v) => {
					this.checked = v;
				})
			);
		}

		const btns = contentEl.createDiv({ cls: 'vault-icloud-sync-buttons' });
		const cancel = btns.createEl('button', { text: '取消' });
		cancel.addEventListener('click', () => {
			this.settle(false);
			this.close();
		});
		const confirm = btns.createEl('button', {
			text: o.confirmText || '确定',
			cls: o.danger ? 'mod-warning' : 'mod-cta',
		});
		this.confirmBtn = confirm;
		confirm.addEventListener('click', () => {
			if (this.items && this.items.length && this.selected.size === 0) {
				new Notice('请先勾选要处理的文件（或点「全选」）');
				return;
			}
			this.settle(true);
			this.close();
		});

		this.updateSummary();
	}

	renderSelector(contentEl) {
		if (!this.items.length) {
			contentEl.createEl('p', { text: this.opts.emptyItemsText || '没有可选的条目。' });
			return;
		}

		const bar = contentEl.createDiv({ cls: 'vault-icloud-sync-list-bar' });
		this.countEl = bar.createSpan({ cls: 'vault-icloud-sync-count' });

		const addBtn = (text, fn) => {
			const b = bar.createEl('button', { text });
			b.addEventListener('click', fn);
			return b;
		};
		addBtn('全选', () => {
			for (const it of this.filteredItems()) this.selected.add(it.path);
			this.renderRows(true);
		});
		addBtn('全不选', () => {
			this.selected.clear();
			this.renderRows(true);
		});
		addBtn('反选', () => {
			for (const it of this.filteredItems()) {
				if (this.selected.has(it.path)) this.selected.delete(it.path);
				else this.selected.add(it.path);
			}
			this.renderRows(true);
		});

		const filter = bar.createEl('input', { placeholder: '筛选路径…' });
		filter.type = 'text';
		filter.addEventListener('input', () => {
			this.filterText = String(filter.value || '').trim().toLowerCase();
			this.renderRows(true);
		});

		this.listEl = contentEl.createDiv({ cls: 'vault-icloud-sync-list' });
		this.moreEl = contentEl.createDiv({ cls: 'vault-icloud-sync-more' });
		this.renderRows(true);
	}

	filteredItems() {
		const kw = this.filterText;
		return kw ? this.items.filter((it) => it.path.toLowerCase().indexOf(kw) !== -1) : this.items;
	}

	renderRows(reset) {
		if (!this.listEl) return;
		if (reset) {
			this.listEl.empty();
			this.shown = 0;
		}
		const rows = this.filteredItems();
		const next = rows.slice(this.shown, this.shown + PLAN_CHUNK);

		for (const it of next) {
			const row = this.listEl.createDiv({ cls: 'vault-icloud-sync-item' });
			const cb = row.createEl('input');
			cb.type = 'checkbox';
			cb.checked = this.selected.has(it.path);
			cb.addEventListener('change', () => {
				if (cb.checked) this.selected.add(it.path);
				else this.selected.delete(it.path);
				this.updateSummary();
			});
			if (it.note) row.createSpan({ cls: 'vault-icloud-sync-note', text: it.note });
			row.createSpan({ cls: 'vault-icloud-sync-path', text: it.path });
		}
		this.shown += next.length;

		if (this.moreEl) {
			this.moreEl.empty();
			if (this.shown < rows.length) {
				const more = this.moreEl.createEl('button', {
					text: `再显示 ${Math.min(PLAN_CHUNK, rows.length - this.shown)} 条（还有 ${rows.length - this.shown} 条）`,
				});
				more.addEventListener('click', () => this.renderRows(false));
			}
		}

		if (!rows.length) {
			this.listEl.createEl('p', { text: '没有匹配的条目', cls: 'setting-item-description' });
		}
		this.updateSummary();
	}

	updateSummary() {
		if (!this.items || !this.items.length) return;
		if (this.countEl) this.countEl.setText(`已选 ${this.selected.size} / ${this.items.length} 项`);
		if (this.confirmBtn) {
			const base = this.opts.confirmText || '确定';
			this.confirmBtn.setText(`${base}（${this.selected.size}）`);
		}
	}

	onClose() {
		this.contentEl.empty();
		this.settle(false); // 已经 settle 过就是空操作
	}
}

const PLAN_CHUNK = 300;

/**
 * 差异处理弹框：列出所有差异，逐项选择「备份（本地 → 备份）」还是「还原（备份 → 本地）」。
 * 默认全不选；kind 决定可选方向：本地独有的只能备份，备份独有的只能还原，两边不同的可切换。
 */
class DiffPlanModal extends Modal {
	constructor(app, rows, opts) {
		super(app);
		this.rows = rows || [];
		this.opts = opts || {};
		this.selected = new Set();
		this.filterText = '';
		this.shown = 0;
		this.listEl = null;
		this.moreEl = null;
		this.countEl = null;
		this.confirmBtn = null;
		this.promise = new Promise((resolve) => {
			this._resolve = resolve;
		});
	}

	ask() {
		this.open();
		return this.promise;
	}

	settle(ok) {
		const fn = this._resolve;
		this._resolve = () => {};
		if (fn) fn({ ok, plan: ok ? this.buildPlan() : [] });
	}

	buildPlan() {
		return this.rows
			.filter((r) => this.selected.has(r.rel))
			.map((r) => ({ rel: r.rel, dir: r.dir }));
	}

	visibleRows() {
		const kw = this.filterText;
		if (!kw) return this.rows;
		return this.rows.filter((r) => r.rel.toLowerCase().indexOf(kw) !== -1);
	}

	onOpen() {
		const { contentEl } = this;
		const o = this.opts;
		contentEl.addClass('vault-icloud-sync-modal');
		contentEl.createEl('h2', { text: '差异处理' });
		contentEl.createEl('p', {
			cls: 'vault-icloud-sync-kv',
			text:
				'默认全不选。勾选后点行内的方向按钮可切换：' +
				'「备份」= 用本地版本覆盖备份，「还原」= 用备份版本覆盖本地。只处理勾选的条目，其余不动。',
		});

		for (const row of o.rows || []) {
			if (!row) continue;
			const p = contentEl.createEl('p', { cls: 'vault-icloud-sync-kv' });
			p.createEl('strong', { text: `${row[0]}：` });
			p.createSpan({ text: String(row[1]) });
		}

		for (const w of o.warns || []) {
			contentEl.createEl('p', { text: w, cls: 'vault-icloud-sync-warn' });
		}

		const bar = contentEl.createDiv({ cls: 'vault-icloud-sync-list-bar' });
		this.countEl = bar.createSpan({ cls: 'vault-icloud-sync-count' });

		const addBtn = (text, fn) => {
			const b = bar.createEl('button', { text });
			b.addEventListener('click', fn);
		};
		addBtn('全不选', () => {
			this.selected.clear();
			this.renderRows(true);
		});
		addBtn('全选', () => {
			for (const r of this.visibleRows()) this.selected.add(r.rel);
			this.renderRows(true);
		});
		addBtn('全部备份', () => {
			for (const r of this.visibleRows()) {
				if (!r.localEnt) continue;
				r.dir = 'push';
				this.selected.add(r.rel);
			}
			this.renderRows(true);
		});
		addBtn('全部还原', () => {
			for (const r of this.visibleRows()) {
				if (!r.remoteEnt) continue;
				r.dir = 'pull';
				this.selected.add(r.rel);
			}
			this.renderRows(true);
		});

		const filter = bar.createEl('input', { placeholder: '筛选路径…' });
		filter.type = 'text';
		filter.addEventListener('input', () => {
			this.filterText = String(filter.value || '').trim().toLowerCase();
			this.renderRows(true);
		});

		this.listEl = contentEl.createDiv({ cls: 'vault-icloud-sync-list' });
		this.moreEl = contentEl.createDiv({ cls: 'vault-icloud-sync-more' });

		const btns = contentEl.createDiv({ cls: 'vault-icloud-sync-buttons' });
		const cancel = btns.createEl('button', { text: '取消' });
		cancel.addEventListener('click', () => {
			this.settle(false);
			this.close();
		});
		const confirm = btns.createEl('button', { text: '执行所选', cls: 'mod-cta' });
		this.confirmBtn = confirm;
		confirm.addEventListener('click', () => {
			if (this.selected.size === 0) {
				new Notice('请先勾选要处理的差异（或点「全选」）');
				return;
			}
			this.settle(true);
			this.close();
		});

		this.renderRows(true);
	}

	kindNote(kind) {
		if (kind === 'remote-only') return '备份独有';
		if (kind === 'local-only') return '本地独有';
		if (kind === 'conflict') return '类型冲突';
		return '两边不同';
	}

	makeRow(r) {
		const row = this.listEl.createDiv({ cls: 'vault-icloud-sync-item' });
		const cb = row.createEl('input');
		cb.type = 'checkbox';
		cb.checked = this.selected.has(r.rel);
		cb.addEventListener('change', () => {
			if (cb.checked) this.selected.add(r.rel);
			else this.selected.delete(r.rel);
			this.updateSummary();
		});

		row.createSpan({ cls: 'vault-icloud-sync-note', text: this.kindNote(r.kind) });

		if (r.kind === 'both' || r.kind === 'conflict') {
			const chip = row.createEl('button', { cls: 'vault-icloud-sync-dir' });
			chip.setText(r.dir === 'pull' ? '还原' : '备份');
			chip.addEventListener('click', () => {
				r.dir = r.dir === 'pull' ? 'push' : 'pull';
				chip.setText(r.dir === 'pull' ? '还原' : '备份');
				this.updateSummary();
			});
		} else {
			row.createSpan({
				cls: 'vault-icloud-sync-dir is-fixed',
				text: r.kind === 'remote-only' ? '还原' : '备份',
			});
		}

		row.createSpan({ cls: 'vault-icloud-sync-path', text: r.rel });
	}

	renderRows(reset) {
		if (!this.listEl) return;
		if (reset) {
			this.listEl.empty();
			this.shown = 0;
		}
		const vis = this.visibleRows();
		const next = vis.slice(this.shown, this.shown + PLAN_CHUNK);
		for (const r of next) this.makeRow(r);
		this.shown += next.length;

		if (this.moreEl) {
			this.moreEl.empty();
			if (this.shown < vis.length) {
				const more = this.moreEl.createEl('button', {
					text: `再显示 ${Math.min(PLAN_CHUNK, vis.length - this.shown)} 条（还有 ${vis.length - this.shown} 条）`,
				});
				more.addEventListener('click', () => this.renderRows(false));
			}
		}
		if (!vis.length) {
			this.listEl.createEl('p', { text: '没有匹配的条目', cls: 'setting-item-description' });
		}
		this.updateSummary();
	}

	updateSummary() {
		let push = 0;
		let pull = 0;
		for (const r of this.rows) {
			if (!this.selected.has(r.rel)) continue;
			if (r.dir === 'pull') pull += 1;
			else push += 1;
		}
		const vis = this.visibleRows().length;
		if (this.countEl) {
			this.countEl.setText(
				`已选 ${this.selected.size} 项（备份 ${push} · 还原 ${pull}）· 当前列出 ${vis}/${this.rows.length}`
			);
		}
		if (this.confirmBtn) this.confirmBtn.setText(`执行所选（${this.selected.size}）`);
	}

	onClose() {
		this.contentEl.empty();
		this.settle(false); // 已经 settle 过就是空操作
	}
}

/* ------------------------------------------------------------------ 结果弹窗 */

class LastRunModal extends Modal {
	constructor(app, state, logPath) {
		super(app);
		this.state = state || {};
		this.logPath = logPath;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('vault-icloud-sync-modal');
		contentEl.createEl('h2', { text: 'iCloud 备份同步 · 上次结果' });

		const kv = (k, v) => {
			const p = contentEl.createEl('p', { cls: 'vault-icloud-sync-kv' });
			p.createEl('strong', { text: `${k}：` });
			p.createSpan({ text: String(v) });
		};

		const r = this.state.lastRun;
		contentEl.createEl('h3', { text: '上次同步（本地 → 备份）' });
		if (!r) {
			contentEl.createEl('p', { text: '还没有运行记录。' });
		} else {
			kv('时间', r.time);
			kv('触发方式', `${r.mode === 'auto' ? '每日自动' : '手动'}${r.dryOnly ? '（仅检查）' : ''}`);
			kv('结果', r.ok ? '成功' : '失败');
			kv('新增', r.created);
			kv('更新', r.updated);
			kv(
				'iCloud 多余',
				r.trashed ? `${r.extra}（已移入回收目录 ${r.trashed} 项）` : `${r.extra}（按设置保留，不删除）`
			);
			kv('用时', `${r.duration} 秒`);
			if (r.message) kv('说明', r.message);
			if (r.samples && r.samples.length) {
				contentEl.createEl('h3', { text: `差异样例（最多 ${SAMPLE_LIMIT} 条）` });
				contentEl.createEl('pre', { text: r.samples.join('\n') });
			}
		}

		const rest = this.state.lastRestore;
		contentEl.createEl('h3', { text: '上次恢复（备份 → 本地）' });
		if (!rest) {
			contentEl.createEl('p', { text: '还没有恢复记录。' });
		} else {
			kv('时间', rest.time);
			kv('结果', rest.ok ? '成功' : '失败');
			kv('写入本地', `新增 ${rest.created || 0} · 覆盖 ${rest.updated || 0}`);
			if (rest.trashed) kv('移入回收目录', `${rest.trashed} 项`);
			kv('用时', `${rest.duration} 秒`);
			if (rest.message) kv('说明', rest.message);
		}

		const clean = this.state.lastClean;
		contentEl.createEl('h3', { text: '上次清理备份冗余' });
		if (!clean) {
			contentEl.createEl('p', { text: '还没有清理记录。' });
		} else {
			kv('时间', clean.time);
			kv('结果', clean.ok ? '成功' : '有失败项');
			kv('移走文件', `${clean.removed || 0} 个`);
			kv('移除空目录', `${clean.dirs || 0} 个`);
			if (clean.failed) kv('失败', `${clean.failed} 项`);
			if (clean.dir) kv('回收目录', clean.dir);
			kv('用时', `${clean.duration} 秒`);
			if (clean.message) kv('说明', clean.message);
		}

		const plan = this.state.lastPlan;
		contentEl.createEl('h3', { text: '上次差异处理（仅检查差异 → 执行所选）' });
		if (!plan) {
			contentEl.createEl('p', { text: '还没有差异处理记录。' });
		} else {
			kv('时间', plan.time);
			kv('结果', plan.ok ? '成功' : '有失败项');
			kv('备份（本地 → 备份）', `${plan.pushed || 0} 个`);
			kv('还原（备份 → 本地）', `${plan.pulled || 0} 个`);
			if (plan.failed) kv('失败', `${plan.failed} 项`);
			kv('用时', `${plan.duration} 秒`);
			if (plan.message) kv('说明', plan.message);
			if (plan.samples && plan.samples.length) {
				contentEl.createEl('pre', { text: plan.samples.join('\n') });
			}
		}

		if (this.logPath) {
			const p = contentEl.createEl('p', { cls: 'vault-icloud-sync-kv' });
			p.createEl('strong', { text: '完整日志：' });
			p.createSpan({ text: this.logPath });
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ------------------------------------------------------------------ 设置面板 */

class VaultICloudSyncSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Vault iCloud Sync 设置' });

		const vaultRoot = this.plugin.vaultRoot() || '(未知)';
		containerEl.createEl('p', {
			text: `当前打开的 vault：${vaultRoot}`,
			cls: 'setting-item-description',
		});

		new Setting(containerEl)
			.setName('启用每日自动同步')
			.setDesc('每天首次启动 Obsidian 后，延迟指定秒数自动检查并同步一次。')
			.addToggle((t) =>
				t.setValue(!!this.plugin.settings.autoEnabled).onChange(async (v) => {
					this.plugin.settings.autoEnabled = v;
					await this.plugin.saveAll();
				})
			);

		new Setting(containerEl)
			.setName('启动后延迟（秒）')
			.setDesc('默认 60 秒，等 Obsidian 启动、索引与其它插件加载完毕后再开始。')
			.addText((t) =>
				t
					.setPlaceholder('60')
					.setValue(String(this.plugin.settings.delaySeconds))
					.onChange(async (v) => {
						const n = Number(v);
						this.plugin.settings.delaySeconds = Number.isFinite(n) && n >= 0 ? n : 60;
						await this.plugin.saveAll();
					})
			);

		new Setting(containerEl)
			.setName('iCloud 备份目录（同步目标）')
			.setDesc('本地文件会被单向复制到这里。此目录里本地不存在的文件默认不会被删除。')
			.addText((t) =>
				t
					.setPlaceholder('~/Library/Mobile Documents/iCloud~md~obsidian/Documents/你的仓库名')
					.setValue(this.plugin.settings.remoteRoot)
					.onChange(async (v) => {
						this.plugin.settings.remoteRoot = v.trim();
						await this.plugin.saveAll();
					})
			);

		new Setting(containerEl)
			.setName('本地 vault 根目录')
			.setDesc('留空表示使用「当前打开的 vault」。一般无需填写。')
			.addText((t) =>
				t
					.setPlaceholder('留空 = 当前 vault')
					.setValue(this.plugin.settings.localRoot)
					.onChange(async (v) => {
						this.plugin.settings.localRoot = v.trim();
						await this.plugin.saveAll();
					})
			);

		new Setting(containerEl)
			.setName('按文件内容比对（MD5）')
			.setDesc(
				'默认按「大小 + 修改时间（秒）」比对，和 rsync 的判断标准一致，速度最快。' +
					'开启后按 MD5 逐一比对内容，能发现「大小和修改时间都一样但内容不同」的极端情况，' +
					'代价是每天要读完整仓库（两边各读一遍），大仓库明显变慢。'
			)
			.addToggle((t) =>
				t.setValue(!!this.plugin.settings.checksum).onChange(async (v) => {
					this.plugin.settings.checksum = v;
					await this.plugin.saveAll();
				})
			);

		new Setting(containerEl)
			.setName('镜像删除 iCloud 多余文件')
			.setDesc(
				'默认关闭。开启后 iCloud 侧本地已不存在的文件会被移入备份目录下的 ' +
					'.vault-sync-trash/时间戳/ 目录，可随时找回。注意：手机上新建的笔记也会被移走。'
			)
			.addToggle((t) =>
				t.setValue(!!this.plugin.settings.mirrorDelete).onChange(async (v) => {
					this.plugin.settings.mirrorDelete = v;
					await this.plugin.saveAll();
				})
			);

		new Setting(containerEl)
			.setName('有变更时提示')
			.setDesc('同步成功且确有新增/更新时弹出 Notice。')
			.addToggle((t) =>
				t.setValue(!!this.plugin.settings.notifyOnSuccess).onChange(async (v) => {
					this.plugin.settings.notifyOnSuccess = v;
					await this.plugin.saveAll();
				})
			);

		new Setting(containerEl)
			.setName('无变更时也提示')
			.setDesc('两边一致时也弹一次「无需同步」的 Notice。')
			.addToggle((t) =>
				t.setValue(!!this.plugin.settings.notifyOnNoChange).onChange(async (v) => {
					this.plugin.settings.notifyOnNoChange = v;
					await this.plugin.saveAll();
				})
			);

		new Setting(containerEl)
			.setName('超时（秒）')
			.setDesc('单次 rsync 的最长运行时间，默认 1800 秒（30 分钟）。')
			.addText((t) =>
				t
					.setPlaceholder('1800')
					.setValue(String(this.plugin.settings.timeoutSeconds))
					.onChange(async (v) => {
						const n = Number(v);
						this.plugin.settings.timeoutSeconds = Number.isFinite(n) && n >= 30 ? n : 1800;
						await this.plugin.saveAll();
					})
			);

		new Setting(containerEl)
			.setName('排除规则')
			.setDesc(
				'每行一条规则。以 / 开头表示只排除 vault 根目录下的这一项（如 /.opencode）；' +
					'不含 / 则表示按文件名匹配任意层级（如 .DS_Store）。'
			)
			.addTextArea((t) => {
				t.setValue((this.plugin.settings.excludes || []).join('\n')).onChange(async (v) => {
					this.plugin.settings.excludes = v
						.split('\n')
						.map((s) => s.trim())
						.filter(Boolean);
					await this.plugin.saveAll();
				});
				t.inputEl.rows = 8;
				t.inputEl.style.width = '100%';
			});

		new Setting(containerEl)
			.setName('立即运行一次')
			.setDesc('先「仅检查差异」看清单：弹框里可逐项选择「备份（本地→备份）」或「还原（备份→本地）」再执行。')
			.addButton((b) =>
				b.setButtonText('仅检查差异').onClick(() => this.plugin.openDiffPlan())
			)
			.addButton((b) =>
				b.setButtonText('立即同步').setCta().onClick(() => this.plugin.runSync('manual'))
			)
			.addButton((b) => b.setButtonText('上次结果').onClick(() => this.plugin.showLastResult()));

		new Setting(containerEl)
			.setName('反向操作')
			.setDesc(
				'「按备份恢复本仓库」= 用 iCloud 备份覆盖本地；' +
					'「清理备份冗余」= 把备份里本地已没有的文件移入备份目录的回收目录。' +
					'两者都会先弹确认框，在框里逐项勾选要恢复 / 要清理的文件，默认全不选。'
			)
			.addButton((b) =>
				b.setButtonText('按备份恢复本仓库').onClick(() => this.plugin.runRestore())
			)
			.addButton((b) =>
				b.setButtonText('清理备份冗余').onClick(() => this.plugin.runCleanRemote())
			);

		const today = dateKey();
		containerEl.createEl('p', {
			text:
				`今日自动同步标记：${this.plugin.state.lastAutoDate || '（无）'}  ·  今天：${today}` +
				(this.plugin.state.lastAutoDate === today ? '（今日已执行）' : '（今日未执行）'),
			cls: 'setting-item-description',
		});
	}
}

module.exports = VaultICloudSyncPlugin;
