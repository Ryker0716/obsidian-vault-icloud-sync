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

	console.log('\n' + results.join('\n'));
	console.log(process.exitCode ? '\n❌ 有失败用例' : '\n✅ 全部通过');
	fs.rmSync(TMP, { recursive: true, force: true });
})().catch((e) => {
	console.error('运行测试时出错：', e);
	console.error(results.join('\n'));
	process.exit(1);
});
