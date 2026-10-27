'use strict';

/*
 * 端到端测试：真实文件系统 + 真实 rsync，Obsidian API 用桩替代。
 * 运行：node tests/run.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const assert = require('assert');

const MAIN = path.join(__dirname, '..', 'main.js');
const STUB = path.join(__dirname, 'obsidian-stub.js');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === 'obsidian') return STUB;
	return origResolve.call(this, request, ...rest);
};
global.window = { setTimeout, clearTimeout };

const PluginClass = require(MAIN);
const stub = require(STUB);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-sync-test-'));
const LOCAL = path.join(TMP, 'vault');
const BACKUP = path.join(TMP, 'backup');
const T = 1700000000;

function reset() {
	fs.rmSync(LOCAL, { recursive: true, force: true });
	fs.rmSync(BACKUP, { recursive: true, force: true });
	fs.mkdirSync(LOCAL, { recursive: true });
	fs.mkdirSync(BACKUP, { recursive: true });
}
function w(p, c) {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, c);
	fs.utimesSync(p, T, T);
}
function makePlugin() {
	const p = Object.create(PluginClass.prototype);
	p.app = {
		vault: { adapter: { getBasePath: () => LOCAL }, configDir: '.obsidian' },
		workspace: { onLayoutReady() {} },
		commands: { executeCommandById() {} },
	};
	p.manifest = { id: 'vault-icloud-sync', dir: null };
	p.settings = {
		autoEnabled: false,
		delaySeconds: 60,
		remoteRoot: BACKUP,
		localRoot: '',
		checksum: false,
		mirrorDelete: false,
		notifyOnSuccess: true,
		notifyOnNoChange: false,
		timeoutSeconds: 1800,
		rsyncPath: '/usr/bin/rsync',
		excludes: ['/.obsidian', '/.vault-sync-trash', '.DS_Store'],
	};
	p.state = {};
	p.running = false;
	p.hashCache = new Map();
	p.logPath = null;
	p.saveAll = async () => {};
	p.log = () => {};
	return p;
}
function makePlugin2(settings) {
	const p = makePlugin();
	p.settings = Object.assign({}, settings);
	return p;
}

function clearFlags() {
	delete global.__AUTO_CANCEL;
	delete global.__FORCE_UNCHECKED;
	delete global.__SELECT_ONLY;
	delete global.__NO_SELECTION;
	delete global.__FORCE_CONFIRM_EMPTY;
	stub.setPlanHook(null);
}

const results = [];
async function scenario(name, fn) {
	clearFlags();
	reset();
	try {
		await fn();
		results.push(`  ✓ ${name}`);
	} catch (e) {
		results.push(`  ✗ ${name}\n      ${e.message}`);
		process.exitCode = 1;
	}
}

(async () => {
	/* ---------------- 比对 / 同步 ---------------- */
	await scenario('扫描能识别新增、更新与备份冗余', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(LOCAL, 'b.md'), 'B-local');
		w(path.join(LOCAL, 'dir', 'c.md'), 'C');
		w(path.join(BACKUP, 'a.md'), 'A');
		w(path.join(BACKUP, 'b.md'), 'B-backup');
		w(path.join(BACKUP, 'gone.md'), 'G');
		const p = makePlugin();
		const diff = p.compareTrees(p.walkTree(LOCAL), p.walkTree(BACKUP));
		assert.deepStrictEqual(diff.created.sort(), ['dir/', 'dir/c.md']);
		assert.deepStrictEqual(diff.updated, ['b.md']);
		assert.deepStrictEqual(diff.extra, ['gone.md']);
	});

	await scenario('正向同步只写备份、不删除备份冗余', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(BACKUP, 'gone.md'), 'G');
		const p = makePlugin();
		const r = await p.runSync('manual');
		assert(r && r.ok, `同步应成功：${r && r.message}`);
		assert(fs.existsSync(path.join(BACKUP, 'a.md')), 'a.md 应被同步到备份');
		assert(fs.existsSync(path.join(BACKUP, 'gone.md')), '未开启镜像删除时不应删除');
	});

	await scenario('未配置备份目录时给出提示且不写盘', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		const p = makePlugin();
		p.settings.remoteRoot = '';
		const r = await p.runSync('manual');
		assert.strictEqual(r, null);
	});

	/* ---------------- 恢复 ---------------- */
	await scenario('恢复：默认只写不删，勾选后移走本地独有', async () => {
		w(path.join(LOCAL, 'b.md'), 'B-local');
		w(path.join(LOCAL, 'localonly.md'), 'L');
		w(path.join(LOCAL, 'local-dir', 'z.md'), 'Z');
		w(path.join(BACKUP, 'b.md'), 'B-backup');
		w(path.join(BACKUP, 'newdir', 'n.md'), 'N');
		w(path.join(BACKUP, '.stub.md.icloud'), 'placeholder');
		const p = makePlugin();
		const r = await p.runRestore();
		assert(r && r.ok, `恢复应成功：${r && r.message}`);
		assert.strictEqual(r.created, 1);
		assert.strictEqual(r.updated, 1);
		assert.strictEqual(fs.readFileSync(path.join(LOCAL, 'b.md'), 'utf8'), 'B-backup');
		assert(fs.existsSync(path.join(LOCAL, 'newdir', 'n.md')));
		assert(!fs.existsSync(path.join(LOCAL, '.stub.md.icloud')), '占位文件不应被恢复');
		assert(!fs.existsSync(path.join(LOCAL, 'localonly.md')), '勾选后本地独有应移走');
		assert(!fs.existsSync(path.join(LOCAL, 'local-dir')), '空目录应被移除');
		assert(fs.readdirSync(path.join(LOCAL, '.vault-sync-trash')).length === 1, '应生成回收批次');
	});

	await scenario('恢复：不勾选时本地独有文件保留', async () => {
		global.__FORCE_UNCHECKED = true;
		w(path.join(LOCAL, 'keep.md'), 'K');
		w(path.join(BACKUP, 'remote.md'), 'R');
		const p = makePlugin();
		const r = await p.runRestore();
		assert(r && r.ok);
		assert(fs.existsSync(path.join(LOCAL, 'keep.md')));
		assert(fs.existsSync(path.join(LOCAL, 'remote.md')));
		assert.strictEqual(r.trashed, 0);
	});

	await scenario('恢复：备份为空时中止，不动本地', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		const p = makePlugin();
		const r = await p.runRestore();
		assert.strictEqual(r, null);
		assert(fs.existsSync(path.join(LOCAL, 'a.md')));
	});

	await scenario('恢复：零勾选不改动任何文件', async () => {
		global.__NO_SELECTION = true;
		global.__FORCE_UNCHECKED = true;
		global.__FORCE_CONFIRM_EMPTY = true;
		w(path.join(LOCAL, 'b.md'), 'B-local');
		w(path.join(BACKUP, 'b.md'), 'B-backup-longer');
		const p = makePlugin();
		const r = await p.runRestore();
		assert.strictEqual(r, null);
		assert.strictEqual(fs.readFileSync(path.join(LOCAL, 'b.md'), 'utf8'), 'B-local');
	});

	await scenario('恢复：取消不做任何事', async () => {
		global.__AUTO_CANCEL = true;
		w(path.join(LOCAL, 'b.md'), 'B-local');
		w(path.join(BACKUP, 'b.md'), 'B-backup');
		const p = makePlugin();
		const r = await p.runRestore();
		assert.strictEqual(r, null);
		assert.strictEqual(fs.readFileSync(path.join(LOCAL, 'b.md'), 'utf8'), 'B-local');
	});

	/* ---------------- 清理备份冗余 ---------------- */
	await scenario('清理：只搬所选文件，未选保留，空目录随之移除', async () => {
		global.__SELECT_ONLY = ['gone2.md'];
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(BACKUP, 'a.md'), 'A');
		w(path.join(BACKUP, 'gone1.md'), 'G1');
		w(path.join(BACKUP, 'gone2.md'), 'G2');
		w(path.join(BACKUP, 'sub', 'gone3.md'), 'G3');
		const p = makePlugin();
		const r = await p.runCleanRemote();
		assert(r && r.ok, `清理应成功：${r && r.message}`);
		assert.strictEqual(r.removed, 1);
		assert.strictEqual(r.skipped, 2);
		assert(!fs.existsSync(path.join(BACKUP, 'gone2.md')));
		assert(fs.existsSync(path.join(BACKUP, 'gone1.md')));
		assert(fs.existsSync(path.join(BACKUP, 'sub', 'gone3.md')));
	});

	await scenario('清理：本地为空时拒绝执行', async () => {
		w(path.join(BACKUP, 'a.md'), 'A');
		const p = makePlugin();
		const r = await p.runCleanRemote();
		assert.strictEqual(r, null);
		assert(fs.existsSync(path.join(BACKUP, 'a.md')));
	});

	await scenario('清理：没有冗余时直接报告一致', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(BACKUP, 'a.md'), 'A');
		const p = makePlugin();
		const r = await p.runCleanRemote();
		assert(r && r.ok && r.removed === 0);
	});

	/* ---------------- 差异处理（仅检查差异） ---------------- */
	await scenario('差异处理：本地独有→备份、备份独有→还原、冲突默认备份', async () => {
		w(path.join(LOCAL, 'localonly.md'), 'L');
		w(path.join(LOCAL, 'conflict.md'), 'local-version');
		w(path.join(BACKUP, 'remoteonly.md'), 'R');
		w(path.join(BACKUP, 'conflict.md'), 'backup-version-longer');
		const p = makePlugin();
		stub.setPlanHook((modal) => {
			for (const r of modal.rows) modal.selected.add(r.rel);
			modal.renderRows(true);
			const btn = [];
			stub.walk(modal.contentEl, (el) => {
				if (el.tag === 'button' && /mod-cta/.test(el.cls)) btn.push(el);
			});
			btn[0].listeners.click();
		});
		const r = await p.openDiffPlan();
		assert(r && r.ok, `差异处理应成功：${r && r.message}`);
		assert.strictEqual(r.pushed, 2);
		assert.strictEqual(r.pulled, 1);
		assert.strictEqual(fs.readFileSync(path.join(BACKUP, 'localonly.md'), 'utf8'), 'L');
		assert.strictEqual(fs.readFileSync(path.join(BACKUP, 'conflict.md'), 'utf8'), 'local-version');
		assert.strictEqual(fs.readFileSync(path.join(LOCAL, 'remoteonly.md'), 'utf8'), 'R');
		assert.strictEqual(fs.readFileSync(path.join(LOCAL, 'conflict.md'), 'utf8'), 'local-version');
	});

	await scenario('差异处理：处理后再扫无差异', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(BACKUP, 'b.md'), 'B');
		const p = makePlugin();
		stub.setPlanHook((modal) => {
			for (const r of modal.rows) modal.selected.add(r.rel);
			modal.renderRows(true);
			const btn = [];
			stub.walk(modal.contentEl, (el) => {
				if (el.tag === 'button' && /mod-cta/.test(el.cls)) btn.push(el);
			});
			btn[0].listeners.click();
		});
		const first = await p.openDiffPlan();
		assert(first && first.ok);
		const second = await makePlugin().openDiffPlan();
		assert.strictEqual(second, null, '处理完应不再有差异');
	});

	await scenario('差异处理：按指定方向还原冲突文件，另一侧不动', async () => {
		w(path.join(LOCAL, 'conflict.md'), 'local-version');
		w(path.join(BACKUP, 'conflict.md'), 'backup-version-longer');
		const p = makePlugin();
		stub.setPlanHook((modal) => {
			const row = modal.rows.find((r) => r.rel === 'conflict.md');
			row.dir = 'pull';
			modal.selected.add(row.rel);
			modal.renderRows(true);
			const btn = [];
			stub.walk(modal.contentEl, (el) => {
				if (el.tag === 'button' && /mod-cta/.test(el.cls)) btn.push(el);
			});
			btn[0].listeners.click();
		});
		const r = await p.openDiffPlan();
		assert(r && r.ok);
		assert.strictEqual(fs.readFileSync(path.join(LOCAL, 'conflict.md'), 'utf8'), 'backup-version-longer');
		assert.strictEqual(fs.readFileSync(path.join(BACKUP, 'conflict.md'), 'utf8'), 'backup-version-longer');
	});

	await scenario('差异处理：零勾选不改动任何文件', async () => {
		w(path.join(LOCAL, 'a.md'), 'A-local');
		w(path.join(BACKUP, 'a.md'), 'A-backup-x');
		const p = makePlugin();
		stub.setPlanHook((modal) => {
			const btn = [];
			stub.walk(modal.contentEl, (el) => {
				if (el.tag === 'button' && /mod-cta/.test(el.cls)) btn.push(el);
			});
			btn[0].listeners.click();
			modal.close(); // 真实界面会留在弹框里，这里模拟按 Esc
		});
		const r = await p.openDiffPlan();
		assert.strictEqual(r, null);
		assert.strictEqual(fs.readFileSync(path.join(LOCAL, 'a.md'), 'utf8'), 'A-local');
		assert.strictEqual(fs.readFileSync(path.join(BACKUP, 'a.md'), 'utf8'), 'A-backup-x');
	});

	/* ---------------- 设置页 / 命令注册 ---------------- */
	await scenario('onload 注册命令与设置页，设置页渲染出全部按钮', async () => {
		const p = makePlugin();
		p.loadData = async () => ({ settings: p.settings, state: p.state });
		p.addRibbonIcon = () => {};
		const commands = [];
		p.addCommand = (c) => commands.push(c);
		let tab = null;
		p.addSettingTab = (t) => {
			tab = t;
		};
		await p.onload();
		for (const id of ['sync-now', 'check-only', 'show-last', 'reset-daily-flag', 'restore-from-backup', 'clean-remote-extras']) {
			assert(commands.some((c) => c.id === id), `缺少命令 ${id}`);
		}
		const root = stub.makeEl('div');
		tab.containerEl = root;
		tab.plugin = p;
		tab.app = p.app;
		tab.display();
		const texts = [];
		stub.walk(root, (el) => {
			if (el.text) texts.push(el.text);
		});
		for (const label of ['仅检查差异', '立即同步', '上次结果', '按备份恢复本仓库', '清理备份冗余']) {
			assert(texts.includes(label), `设置页缺少按钮「${label}」`);
		}
	});


	/* ---------------- 1.2.1 修复回归 ---------------- */
	await scenario('镜像删除：iCloud 占位不被 rsync 硬删，普通冗余仍进回收', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(BACKUP, 'a.md'), 'A');
		w(path.join(BACKUP, 'gone.md'), 'G');
		w(path.join(BACKUP, '.gone.md.icloud'), 'placeholder');
		const p = makePlugin();
		p.settings.mirrorDelete = true;
		const r = await p.runSync('manual');
		assert(r && r.ok, `同步应成功：${r && r.message}`);
		assert(!fs.existsSync(path.join(BACKUP, 'gone.md')), '普通冗余应进回收');
		assert(fs.existsSync(path.join(BACKUP, '.gone.md.icloud')), '占位文件不能被 rsync --delete 硬删');
	});

	await scenario('差异处理：目标是符号链接时不穿透覆写链接目标', async () => {
		const target = path.join(TMP, 'outside-target.txt');
		fs.writeFileSync(target, 'KEEP-ME');
		w(path.join(LOCAL, 'x.md'), 'local-content');
		fs.symlinkSync(target, path.join(BACKUP, 'x.md'));
		const p = makePlugin();
		stub.setPlanHook((modal) => {
			for (const r of modal.rows) {
				if (r.localEnt) {
					r.dir = 'push';
					modal.selected.add(r.rel);
				}
			}
			modal.renderRows(true);
			const btn = [];
			stub.walk(modal.contentEl, (el) => {
				if (el.tag === 'button' && /mod-cta/.test(el.cls)) btn.push(el);
			});
			btn[0].listeners.click();
		});
		const r = await p.openDiffPlan();
		assert(r && r.ok, `应成功：${r && r.message}`);
		assert.strictEqual(fs.readFileSync(target, 'utf8'), 'KEEP-ME', '链接指向的外部文件不能被覆写');
		assert(!fs.lstatSync(path.join(BACKUP, 'x.md')).isSymbolicLink(), '备份侧应变成普通文件');
		assert.strictEqual(fs.readFileSync(path.join(BACKUP, 'x.md'), 'utf8'), 'local-content');
	});

	await scenario('镜像删除：本地为空时中止，备份不被搬空', async () => {
		w(path.join(BACKUP, 'a.md'), 'A');
		w(path.join(BACKUP, 'b.md'), 'B');
		const p = makePlugin();
		p.settings.mirrorDelete = true;
		const r = await p.runSync('manual');
		assert(r && !r.ok, '应判失败并中止');
		assert(/中止/.test(r.message), `提示应说明中止：${r.message}`);
		assert(fs.existsSync(path.join(BACKUP, 'a.md')), '备份文件必须原样保留');
		assert(fs.existsSync(path.join(BACKUP, 'b.md')), '备份文件必须原样保留');
		assert(!fs.existsSync(path.join(BACKUP, '.vault-sync-trash')), '不应产生回收动作');
	});

	await scenario('恢复：备份同名文件被驱逐成占位时，不计入本地独有', async () => {
		w(path.join(LOCAL, 'foo.md'), 'alive');
		w(path.join(LOCAL, 'real.md'), 'R');
		w(path.join(BACKUP, 'real.md'), 'R');
		w(path.join(BACKUP, '.foo.md.icloud'), 'placeholder');
		const p = makePlugin();
		const r = await p.runRestore();
		assert(r && r.ok, `恢复应成功：${r && r.message}`);
		assert.strictEqual(r.trashed, 0, '备份里只是没下载的活笔记不能被搬进回收');
		assert(fs.existsSync(path.join(LOCAL, 'foo.md')), 'foo.md 必须原地保留');
	});

	await scenario('MD5 模式：同步后改同大小文件，差异清单仍能发现', async () => {
		w(path.join(LOCAL, 'a.md'), 'AAAA');
		w(path.join(BACKUP, 'a.md'), 'AAAA'); // 先让两边一致，把「相等」的哈希留在缓存里
		const p = makePlugin();
		p.settings.checksum = true;
		const sync = await p.runSync('manual');
		assert(sync && sync.ok, `先同步一次：${sync && sync.message}`);
		w(path.join(LOCAL, 'a.md'), 'CCCC'); // 同大小，仅内容变化，mtime 也保持不变
		let seen = -1;
		stub.setPlanHook((modal) => {
			seen = modal.rows.length;
			modal.close();
		});
		const r = await p.openDiffPlan();
		assert.strictEqual(seen, 1, `差异清单应列出 1 条，实际 ${seen}`);
		assert.strictEqual(r, null, '未勾选不执行');
	});

	await scenario('空目录：仅检查差异会提示，清理会移除备份侧冗余空目录', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(BACKUP, 'a.md'), 'A');
		fs.mkdirSync(path.join(LOCAL, 'newdir'));
		fs.mkdirSync(path.join(BACKUP, 'olddir'));
		const before = stub.notices.length;
		const p = makePlugin();
		stub.setPlanHook(() => {});
		const r = await p.openDiffPlan();
		assert.strictEqual(r, null);
		assert(
			stub.notices.slice(before).some((n) => /空目录差异/.test(n)),
			'应提示空目录差异而不是声称完全一致'
		);
		const c = await makePlugin().runCleanRemote();
		assert(c && c.ok, `清理应成功：${c && c.message}`);
		assert.strictEqual(c.dirs, 1, `应移除 1 个空目录，实际 ${c.dirs}`);
		assert(!fs.existsSync(path.join(BACKUP, 'olddir')), '备份侧冗余空目录应被移除');
	});


	/* ---------------- 1.3.0 修复回归 ---------------- */
	await scenario('排除规则：中缀斜杠与 rsync 口径一致，不再假新增', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(LOCAL, 'deep', 'x', 'sub2', 'junk.md'), 'J');
		const p = makePlugin();
		p.settings.excludes = ['/.obsidian', '/.vault-sync-trash', '.DS_Store', 'sub2/junk.md'];
		const first = await p.runSync('manual');
		assert(first && first.ok, `首次同步应成功：${first && first.message}`);
		assert(!fs.existsSync(path.join(BACKUP, 'deep', 'x', 'sub2', 'junk.md')), '中缀规则应排除深层文件');
		assert(!fs.existsSync(path.join(BACKUP, 'a.md')) === false, 'a.md 应被同步');
		const second = await makePlugin2(p.settings).runSync('manual');
		assert(second && second.ok);
		assert.strictEqual(second.created, 0, `第二轮不应再报新增，实际 ${second.created}`);
		assert.strictEqual(second.updated, 0, `第二轮不应再报更新，实际 ${second.updated}`);
	});

	await scenario('类型冲突：差异清单可见，备份方向（本地目录压备份文件）', async () => {
		w(path.join(LOCAL, 'foo', 'inner.md'), 'I');
		w(path.join(BACKUP, 'foo'), 'old-file');
		const p = makePlugin();
		stub.setPlanHook((modal) => {
			const row = modal.rows.find((r) => r.rel === 'foo');
			assert.strictEqual(row && row.kind, 'conflict', '类型冲突应作为独立行出现');
			modal.selected.add('foo');
			modal.renderRows(true);
			const btn = [];
			stub.walk(modal.contentEl, (el) => {
				if (el.tag === 'button' && /mod-cta/.test(el.cls)) btn.push(el);
			});
			btn[0].listeners.click();
		});
		const r = await p.openDiffPlan();
		assert(r && r.ok, `应成功：${r && r.message}`);
		assert(fs.statSync(path.join(BACKUP, 'foo')).isDirectory(), '备份侧应变成目录');
		assert.strictEqual(fs.readFileSync(path.join(BACKUP, 'foo', 'inner.md'), 'utf8'), 'I');
		const trashBase = path.join(BACKUP, '.vault-sync-trash');
		const batch = fs.readdirSync(trashBase)[0];
		assert(fs.statSync(path.join(trashBase, batch, 'foo')).isFile(), '原备份文件应进回收目录');
	});

	await scenario('类型冲突：还原方向（备份目录替换本地文件）', async () => {
		w(path.join(LOCAL, 'bar'), 'local-file');
		w(path.join(BACKUP, 'bar', 'inner.md'), 'BI');
		const p = makePlugin();
		stub.setPlanHook((modal) => {
			const row = modal.rows.find((r) => r.rel === 'bar');
			row.dir = 'pull';
			modal.selected.add('bar');
			modal.renderRows(true);
			const btn = [];
			stub.walk(modal.contentEl, (el) => {
				if (el.tag === 'button' && /mod-cta/.test(el.cls)) btn.push(el);
			});
			btn[0].listeners.click();
		});
		const r = await p.openDiffPlan();
		assert(r && r.ok, `应成功：${r && r.message}`);
		assert(fs.statSync(path.join(LOCAL, 'bar')).isDirectory(), '本地侧应变成目录');
		assert.strictEqual(fs.readFileSync(path.join(LOCAL, 'bar', 'inner.md'), 'utf8'), 'BI');
		const trashBase = path.join(LOCAL, '.vault-sync-trash');
		const batch = fs.readdirSync(trashBase)[0];
		assert(fs.statSync(path.join(trashBase, batch, 'bar')).isFile(), '原本地文件应进回收目录');
	});

	await scenario('类型冲突：同步不再失败（备份侧先搬回收）', async () => {
		w(path.join(LOCAL, 'x'), 'local-x');
		w(path.join(BACKUP, 'x', 'inner.md'), 'old');
		const p = makePlugin();
		const r = await p.runSync('manual');
		assert(r && r.ok, `同步不应再因类型冲突失败：${r && r.message}`);
		assert(!fs.lstatSync(path.join(BACKUP, 'x')).isDirectory(), '备份侧应被本地文件替换');
		assert.strictEqual(fs.readFileSync(path.join(BACKUP, 'x'), 'utf8'), 'local-x');
		assert(r.trashed >= 1, '备份侧原目录应进回收');
	});

	await scenario('类型冲突：恢复可处理（本地文件被备份目录替换）', async () => {
		w(path.join(LOCAL, 'y'), 'local-y');
		w(path.join(BACKUP, 'y', 'inner.md'), 'YI');
		global.__SELECT_ONLY = ['y'];
		const p = makePlugin();
		const r = await p.runRestore();
		assert(r && r.ok, `恢复应成功：${r && r.message}`);
		assert(fs.statSync(path.join(LOCAL, 'y')).isDirectory(), '本地侧应变成目录');
		assert.strictEqual(fs.readFileSync(path.join(LOCAL, 'y', 'inner.md'), 'utf8'), 'YI');
		const trashBase = path.join(LOCAL, '.vault-sync-trash');
		const batch = fs.readdirSync(trashBase)[0];
		assert(fs.statSync(path.join(trashBase, batch, 'y')).isFile(), '原本地文件应进回收目录');
	});

	await scenario('差异清单弹框期间占用任务锁', async () => {
		w(path.join(LOCAL, 'a.md'), 'A-local');
		w(path.join(BACKUP, 'a.md'), 'A-backup');
		const p = makePlugin();
		let midSync = null;
		stub.setPlanHook((modal) => {
			midSync = p.runSync('manual'); // 弹框打开期间尝试同步
			modal.rows.forEach((r) => modal.selected.add(r.rel));
			modal.renderRows(true);
			const btn = [];
			stub.walk(modal.contentEl, (el) => {
				if (el.tag === 'button' && /mod-cta/.test(el.cls)) btn.push(el);
			});
			btn[0].listeners.click();
		});
		const r = await p.openDiffPlan();
		assert(r && r.ok, `应成功：${r && r.message}`);
		assert.strictEqual(await midSync, null, '弹框期间的同步应被任务锁挡住');
		const again = await p.runSync('manual');
		assert(again && again.ok, '执行完释放任务锁，后续同步可用');
	});

	await scenario('占位残留：真身同步后，备份侧占位进回收', async () => {
		w(path.join(LOCAL, 'foo.md'), 'F');
		w(path.join(BACKUP, 'a.md'), 'A');
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(BACKUP, '.foo.md.icloud'), 'placeholder');
		const p = makePlugin();
		const r = await p.runSync('manual');
		assert(r && r.ok, `同步应成功：${r && r.message}`);
		assert(fs.existsSync(path.join(BACKUP, 'foo.md')), '真身应被同步到备份');
		assert(!fs.existsSync(path.join(BACKUP, '.foo.md.icloud')), '真身存在后占位应移入回收');
		assert(r.trashed >= 1, '应计入 trashed');
	});

	await scenario('普通 .icloud 文件不再被当成占位（可正常同步）', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(BACKUP, 'a.md'), 'A');
		w(path.join(LOCAL, 'report.icloud'), 'R');
		w(path.join(LOCAL, '.stub.md.icloud'), 'stub');
		const p = makePlugin();
		const r = await p.runSync('manual');
		assert(r && r.ok, `同步应成功：${r && r.message}`);
		assert(fs.existsSync(path.join(BACKUP, 'report.icloud')), '普通 .icloud 文件应被同步');
		assert(!fs.existsSync(path.join(BACKUP, '.stub.md.icloud')), '点前缀占位形态不应被同步');
		const second = await p.runSync('manual');
		assert(second && second.created === 0 && second.updated === 0, '第二轮不应有假差异');
	});

	await scenario('备份目录是文件时：各入口都拒绝而不是误报', async () => {
		const aFile = path.join(TMP, 'not-a-dir');
		fs.writeFileSync(aFile, 'x');
		w(path.join(LOCAL, 'a.md'), 'A');
		const p = makePlugin();
		p.settings.remoteRoot = aFile;
		assert.strictEqual(await p.runSync('manual'), null, '同步应拒绝');
		assert.strictEqual(await p.runCleanRemote(), null, '清理应拒绝（不能误报一致）');
		assert.strictEqual(await p.runRestore(), null, '恢复应拒绝');
	});

	await scenario('执行前重验：差异清单还原方向不覆盖扫描后的本地新改动', async () => {
		w(path.join(LOCAL, 'b.md'), 'B1');
		w(path.join(BACKUP, 'b.md'), 'B2-backup-long');
		const p = makePlugin();
		stub.setPlanHook((modal) => {
			// 扫描已完成、尚未确认：模拟用户在弹框期间又改了本地文件
			fs.writeFileSync(path.join(LOCAL, 'b.md'), 'B3-new');
			const now = Math.floor(Date.now() / 1000);
			fs.utimesSync(path.join(LOCAL, 'b.md'), now, now);
			const row = modal.rows.find((r) => r.rel === 'b.md');
			row.dir = 'pull';
			modal.selected.add('b.md');
			modal.renderRows(true);
			const btn = [];
			stub.walk(modal.contentEl, (el) => {
				if (el.tag === 'button' && /mod-cta/.test(el.cls)) btn.push(el);
			});
			btn[0].listeners.click();
		});
		const r = await p.openDiffPlan();
		assert(r && r.ok, `应成功：${r && r.message}`);
		assert.strictEqual(fs.readFileSync(path.join(LOCAL, 'b.md'), 'utf8'), 'B3-new', '扫描后的新改动不能被覆盖');
		assert.strictEqual(r.skipped, 1, `应记 1 项跳过，实际 ${r.skipped}`);
	});

	await scenario('执行前重验：恢复不覆盖扫描后的本地新改动', async () => {
		w(path.join(LOCAL, 'b.md'), 'B1');
		w(path.join(BACKUP, 'b.md'), 'B2-longer');
		global.__SELECT_ONLY = ['b.md'];
		const p = makePlugin();
		global.__SELECT_ONLY = null;
		stub.setPlanHook((modal) => {
			fs.writeFileSync(path.join(LOCAL, 'b.md'), 'B3-new');
			const now = Math.floor(Date.now() / 1000);
			fs.utimesSync(path.join(LOCAL, 'b.md'), now, now);
			return false; // 继续正常的勾选+确认流程
		});
		global.__SELECT_ONLY = ['b.md'];
		const r = await p.runRestore();
		global.__SELECT_ONLY = null;
		assert(r && r.ok, `恢复应成功：${r && r.message}`);
		assert.strictEqual(fs.readFileSync(path.join(LOCAL, 'b.md'), 'utf8'), 'B3-new', '扫描后的新改动不能被覆盖');
		assert.strictEqual(r.skipped, 1, `应记 1 项跳过，实际 ${r.skipped}`);
	});

	await scenario('大清单分块渲染（恢复弹框一次 300 行）', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(BACKUP, 'a.md'), 'A');
		for (let i = 0; i < 305; i += 1) {
			w(path.join(BACKUP, `f${String(i).padStart(3, '0')}.md`), `F${i}`);
		}
		let chunkInfo = null;
		stub.setPlanHook((modal) => {
			chunkInfo = {
				rows: modal.listEl ? modal.listEl.children.length : -1,
				more: modal.moreEl ? modal.moreEl.children.length : -1,
			};
			modal.close();
		});
		const r = await makePlugin().runRestore();
		assert.strictEqual(r, null, '未勾选应取消');
		assert(chunkInfo, '应打开弹框');
		assert.strictEqual(chunkInfo.rows, 300, `首屏应渲染 300 行，实际 ${chunkInfo.rows}`);
		assert.strictEqual(chunkInfo.more, 1, '应有「再显示」按钮');
	});

	await scenario('「一致」提示包含 iCloud 多余数', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(BACKUP, 'a.md'), 'A');
		w(path.join(BACKUP, 'extra.md'), 'E');
		const before = stub.notices.length;
		const p = makePlugin();
		p.settings.notifyOnNoChange = true;
		const r = await p.runSync('manual');
		assert(r && r.ok);
		const msg = stub.notices.slice(before).find((n) => n.indexOf('无需同步') !== -1);
		assert(msg, '应有一致提示');
		assert(msg.indexOf('多余 1') !== -1, `提示应含多余数：${msg}`);
	});


	/* ---------------- 1.3.1 复审修复回归 ---------------- */
	await scenario('占位口径：点目录下的普通 .icloud 文件不再误判（P1）', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(BACKUP, 'a.md'), 'A');
		w(path.join(BACKUP, 'sub', '.config', 'x.icloud'), 'real-file'); // 点前缀由目录段提供，不是占位
		w(path.join(BACKUP, 'sub', '.config', '.evicted.md.icloud'), 'ph'); // 这才是占位
		const p = makePlugin();
		p.settings.mirrorDelete = true;
		const r = await p.runSync('manual');
		assert(r && r.ok, `同步应成功：${r && r.message}`);
		assert(
			!fs.existsSync(path.join(BACKUP, 'sub', '.config', 'x.icloud')),
			'x.icloud 应作正常冗余项进回收（不是被 --delete 硬删）'
		);
		assert(r.trashed >= 1, '应计到 trashed（走回收而不是硬删）');
		assert(
			fs.existsSync(path.join(BACKUP, 'sub', '.config', '.evicted.md.icloud')),
			'真占位仍受 --exclude 保护'
		);
	});

	await scenario('真身名提取不吃点目录：带点目录的占位也能豁免本地活文件（P2）', async () => {
		w(path.join(LOCAL, 'sub', '.config', 'foo.md'), 'alive');
		w(path.join(LOCAL, 'real.md'), 'R');
		w(path.join(BACKUP, 'real.md'), 'R');
		w(path.join(BACKUP, 'sub', '.config', '.foo.md.icloud'), 'placeholder');
		const p = makePlugin();
		const r = await p.runRestore();
		assert(r && r.ok, `恢复应成功：${r && r.message}`);
		assert.strictEqual(r.trashed, 0, '点目录下备份未下载的活笔记不能被搬进回收');
		assert(fs.existsSync(path.join(LOCAL, 'sub', '.config', 'foo.md')), 'foo.md 必须原地保留');
	});

	await scenario('冲突行目标扫描后消失：继续复制不误报失败（P3）', async () => {
		w(path.join(LOCAL, 'foo', 'inner.md'), 'I');
		w(path.join(BACKUP, 'foo'), 'old-file');
		const p = makePlugin();
		stub.setPlanHook((modal) => {
			// 弹框期间在「备份侧」把冲突目标删了
			fs.unlinkSync(path.join(BACKUP, 'foo'));
			const row = modal.rows.find((r) => r.rel === 'foo');
			modal.selected.add('foo');
			modal.renderRows(true);
			const btn = [];
			stub.walk(modal.contentEl, (el) => {
				if (el.tag === 'button' && /mod-cta/.test(el.cls)) btn.push(el);
			});
			btn[0].listeners.click();
		});
		const r = await p.openDiffPlan();
		assert(r && r.ok, `目标已消失应直接复制成功，不应报失败：${r && r.message}`);
		assert.strictEqual(r.failed, 0, '不应计失败');
		assert(fs.statSync(path.join(BACKUP, 'foo')).isDirectory(), '备份侧应建成目录');
		assert.strictEqual(fs.readFileSync(path.join(BACKUP, 'foo', 'inner.md'), 'utf8'), 'I');
	});

	await scenario('镜像删除：本地呈占位形态的文件，其备份真身豁免（P4）', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(LOCAL, '.foo.md.icloud'), 'local-placeholder'); // 本地被驱逐，备份有真身
		w(path.join(BACKUP, 'a.md'), 'A');
		w(path.join(BACKUP, 'foo.md'), 'alive-backup');
		w(path.join(BACKUP, 'gone.md'), 'G');
		const p = makePlugin();
		p.settings.mirrorDelete = true;
		const r = await p.runSync('manual');
		assert(r && r.ok, `同步应成功：${r && r.message}`);
		assert(fs.existsSync(path.join(BACKUP, 'foo.md')), '备份真身不能被搬走（本地只是没下载）');
		assert(!fs.existsSync(path.join(BACKUP, 'gone.md')), '真正的冗余仍被移走');
	});

	await scenario('恢复弹框「全选 / 反选」随筛选（P6）', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(BACKUP, 'a.md'), 'A');
		w(path.join(BACKUP, 'keep1.md'), 'K1');
		w(path.join(BACKUP, 'keep2.md'), 'K2');
		w(path.join(BACKUP, 'dead1.md'), 'D1');
		const p = makePlugin();
		stub.setPlanHook((modal) => {
			modal.filterText = 'keep';
			modal.renderRows(true);
			let all = null;
			stub.walk(modal.contentEl, (el) => {
				if (el.tag === 'button' && el.text === '全选') all = el;
			});
			all.listeners.click(); // 应只选中筛选结果里的 keep1 / keep2
			const btn = [];
			stub.walk(modal.contentEl, (el) => {
				if (el.tag === 'button' && /mod-cta|mod-warning/.test(el.cls)) btn.push(el);
			});
			btn[0].listeners.click();
		});
		const r = await p.runRestore();
		assert(r && r.ok, `恢复应成功：${r && r.message}`);
		assert(fs.existsSync(path.join(LOCAL, 'keep1.md')), '筛选命中的应恢复');
		assert(fs.existsSync(path.join(LOCAL, 'keep2.md')), '筛选命中的应恢复');
		assert(!fs.existsSync(path.join(LOCAL, 'dead1.md')), '筛选外的不应被全选恢复');
	});

	await scenario('恢复全部跳过时的提示含「跳过」而不是「一致」（P7）', async () => {
		w(path.join(LOCAL, 'b.md'), 'B1');
		w(path.join(BACKUP, 'b.md'), 'B2-longer');
		const before = stub.notices.length;
		global.__SELECT_ONLY = ['b.md'];
		const p = makePlugin();
		global.__SELECT_ONLY = null;
		stub.setPlanHook(() => {
			fs.writeFileSync(path.join(LOCAL, 'b.md'), 'B3-new');
			const now = Math.floor(Date.now() / 1000);
			fs.utimesSync(path.join(LOCAL, 'b.md'), now, now);
			return false;
		});
		global.__SELECT_ONLY = ['b.md'];
		const r = await p.runRestore();
		global.__SELECT_ONLY = null;
		assert(r && r.ok);
		const msg = stub.notices.slice(before).find((n) => n.indexOf('跳过') !== -1);
		assert(msg, '应提示全部跳过');
		assert(!stub.notices.slice(before).some((n) => n.indexOf('本地内容与备份一致') !== -1), '不该再说一致');
	});

	await scenario('差异清单提示「本地比备份新」的文件数（P10）', async () => {
		w(path.join(LOCAL, 'b.md'), 'B1-local-version');
		w(path.join(BACKUP, 'b.md'), 'B2');
		// 本地 mtime 比备份晚
		const later = T + 600;
		fs.utimesSync(path.join(LOCAL, 'b.md'), later, later);
		let warns2 = null;
		const p = makePlugin();
		stub.setPlanHook((modal) => {
			warns2 = modal.opts.warns;
			modal.close();
		});
		await p.openDiffPlan();
		assert(warns2 && warns2.some((x) => x.indexOf('比备份新') !== -1), `应有本地较新警告：${warns2}`);
	});

	await scenario('只勾选冲突行的子孙项时按跳过算（P11）', async () => {
		w(path.join(LOCAL, 'foo'), 'local-file');
		w(path.join(BACKUP, 'foo', 'inner.md'), 'inner');
		global.__SELECT_ONLY = ['foo/inner.md'];
		const p = makePlugin();
		const r = await p.runRestore();
		global.__SELECT_ONLY = null;
		assert(r && r.ok, `应成功：${r && r.message}`);
		assert.strictEqual(r.failed, 0, '父路径冲突挡着算跳过，不算失败');
		assert.strictEqual(r.skipped, 1, '应记 1 项跳过');
		assert(fs.statSync(path.join(LOCAL, 'foo')).isFile(), '本地 foo 必须原样保留');
	});

	await scenario('搬迁失败时 --delete 不硬删失败项（理论 3）', async () => {
		w(path.join(LOCAL, 'a.md'), 'A');
		w(path.join(BACKUP, 'a.md'), 'A');
		w(path.join(BACKUP, 'gone.md'), 'G');
		// 把回收目录预先做成一个文件 → moveExtrasToTrash 全部失败，注入搬迁失败
		fs.writeFileSync(path.join(BACKUP, '.vault-sync-trash'), 'blocker');
		const p = makePlugin();
		p.settings.mirrorDelete = true;
		const r = await p.runSync('manual');
		assert(fs.existsSync(path.join(BACKUP, 'gone.md')), '搬迁失败的文件必须被 exclude 保护，不能被 --delete 硬删');
		assert(!fs.existsSync(path.join(BACKUP, '.vault-sync-trash', '20261027-x')), '不应出现假批次');
		fs.unlinkSync(path.join(BACKUP, '.vault-sync-trash')); // 还原注入
		const p2 = makePlugin();
		p2.settings.mirrorDelete = true;
		const r2 = await p2.runSync('manual');
		assert(!fs.existsSync(path.join(BACKUP, 'gone.md')), '恢复回收目录后，冗余应能正常进回收');
	});

	console.log('\n' + results.join('\n'));
	console.log(process.exitCode ? '\n❌ 有失败用例' : '\n✅ 全部通过');
	fs.rmSync(TMP, { recursive: true, force: true });
})().catch((e) => {
	console.error('运行测试时出错：', e);
	console.error(results.join('\n'));
	process.exit(1);
});
