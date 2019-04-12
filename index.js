#!/usr/bin/env node
const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const ftp = require('basic-ftp');
const ProgressBar = require('progress');
const inquirer = require('inquirer');
const config = require('./config.json');

const ui = new inquirer.ui.BottomBar();
const DESKTOP = path.resolve(require('os').homedir(), 'Desktop');
const TODAY = new Date().toISOString().substr(0, 10);
let FTP;

process.on('SIGINT', async () => {
	ui.updateBottomBar('Przerywam...');
	await FTP.close();
	ui.updateBottomBar('');
	ui.log.write('(Przerwane)');
	process.exit(0);
});

async function getProgramTitle (pwd) {
	const local = path.resolve(DESKTOP, 'info.amri');
	const remote = `${pwd}/info.amri`;
	await FTP.download(fs.createWriteStream(local), remote);
	let ar = fs
		.readFileSync(local, 'utf8')
		.replace(/\f/, '')
		.match(/[\wĄąĆćĘęŁłŃńÓóŚśŻżŹź]{1}[\s\wĄąĆćĘęŁłŃńÓóŚśŻżŹź]{2,}/g)
		.slice(1);
	fs.unlink(local);
	ar = ar.slice(0, ar.indexOf('pol'));
	ar.pop();
	const prog = ar.join(' ');
	return prog.trim();
}

async function getProgramFiles (pwd, title) {
	await FTP.cd(pwd);
	let files = await FTP.list();
	await FTP.cd('/');
	return files
		.filter(i => i.name !== 'info.amri')
		.map((f, i) => {
			const idx = files.length > 2 ? ' ' + (i + 1) : '';
			const local = path.resolve(DESKTOP, title + idx + '.mp4');
			const remote = pwd + '/' + f.name;
			return { remote, local, size: f.size };
		});
}

async function parseName (item) {
	const chunks = item.replace(/^\[([\d\w-_]+)\]$/, '$1').split('_');
	const time = chunks
		.pop()
		.substr(0, 5)
		.replace('-', '.');
	const date = chunks.pop();
	const station = chunks.join(' ');
	const title = await getProgramTitle(item);

	const realName = `${date} ${time} ${station} - ${title}`;
	const files = await getProgramFiles(item, realName);

	const isToday = realName.startsWith(TODAY);
	const color = isToday ? chalk : chalk.dim;
	const name = color(`${date} ${time} ${station} - ${title}`);
	const short = '\n' + name;
	return { name, short, value: { name: realName, title, files } };
}

async function fetchNames (flist) {
	const list = flist
		.map(i => i.name.trim())
		.filter(i => i !== 'REC_TimeShifting')
		.filter(i => /^\[[\w\d_-]+\]$/.test(i));

	for (let [i, item] of list.entries()) {
		list[i] = await parseName(item);
	}
	list.sort((a, b) => a.name.localeCompare(b.name));
	return list;
}

async function ask (choices) {
	if (!choices || !choices.length) {
		ui.log.write(chalk.green('\nNie ma nagrań'));
		return;
	}
	return await inquirer
		.prompt([
			{
				type: 'checkbox',
				name: 'nagrania',
				paginated: false,
				prefix: ' \n',
				suffix: ' \n',
				message: 'Nagrania:',
				pageSize: 100,
				choices,
			},
		])
		.then(res => res.nagrania);
}

async function copyItem (item) {
	ui.log.write(`- ${chalk.green(item.name)}`);
	const barCfg = {
		width: 50,
		total: item.size,
		clear: true,
		incomplete: '\u001b[40m \u001b[0m', // black
		complete: '\u001b[47m \u001b[0m', // white
	};
	const bar = new ProgressBar('  :bar :percent  |  prędkość :speed mb/s  |  pozostało :timeleft', barCfg);
	let sofar = 0;

	FTP.trackProgress(info => {
		const elapsed = (new Date - bar.start) / 1000;
		let speed = Math.round(bar.curr / elapsed / 100000) / 10;
		if (!isFinite(speed)) speed = 0;

		let ratio = bar.curr / bar.total;
		ratio = Math.min(Math.max(ratio, 0), 1);
		const percent = Math.floor(ratio * 100);
		const eta = (percent == 100) ? 0 : elapsed * (bar.total / bar.curr - 1);
		const timeleft = eta > 60 ? Math.round(eta / 6) / 10 + ' min' : Math.round(eta) + ' sec';

		bar.tick(info.bytes - sofar, { speed, timeleft });
		sofar = info.bytes;
	});
	await FTP.download(fs.createWriteStream(item.local), item.remote);
	FTP.trackProgress();
}

async function copy (items) {
	if (!items || !items.length) return;
	const files = [];
	items.forEach(item => {
		item.files.forEach(({ local, remote, size }, i) => {
			const idx = item.files.length > 1 ? ' cz. ' + (i + 1) : '';
			files.push({ name: item.name + idx, local, remote, size });
		});
	});

	ui.log.write('');
	for (let file of files) await copyItem(file);
	ui.log.write(`\nGotowe! ${files.length} nagrania skopiowane.`);
}

async function init () {
	FTP = new ftp.Client();
	try {
		await FTP.access(config);
		const list = await FTP.list();
		const names = await fetchNames(list);
		const answers = await ask(names);
		await copy(answers);
		FTP.close();
	}
	catch (e) {
		ui.log.write(chalk.red('\nNie można się połączyć z TV.'));
		process.exit(1);
	}
}

init();
