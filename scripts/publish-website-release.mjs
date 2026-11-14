#!/usr/bin/env node
/** Publish only larryagent.online's manual downloads. No updater manifests are modified. */
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {PATHS} from './release/config.mjs';
import {makeWebsiteDownloads, websiteReleaseAssets, WEBSITE_RELEASE_REPO} from './release/website-downloads.mjs';

function gh(args, input) {
  const result = spawnSync('gh', args, {input, encoding:'utf8', maxBuffer:16*1024*1024, env:{...process.env, GH_PROMPT_DISABLED:'1'}});
  if (result.error) throw new Error(`GitHub CLI is required: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `gh ${args[0]} failed`);
  return result.stdout;
}
function api(path, body, method) {
  return JSON.parse(gh(['api', path, ...(body ? ['--method', method || 'POST', '--input', '-'] : [])], body ? JSON.stringify(body) : undefined));
}
async function hashStream(stream, destination) {
  const hash = createHash('sha256');
  const tap = new Transform({transform(chunk, encoding, done){ hash.update(chunk); done(null, chunk); }});
  if (destination) await pipeline(stream, tap, createWriteStream(destination));
  else { tap.resume(); await pipeline(stream, tap); }
  return hash.digest('hex');
}
export async function downloadVerified(url, sha, destination) {
  const response = await fetch(url, {signal:AbortSignal.timeout(300000)});
  if (response.status !== 200 || !response.body) throw new Error(`Download failed: ${response.status} ${url}`);
  const actual = await hashStream(Readable.fromWeb(response.body), destination);
  if (actual !== sha) throw new Error(`SHA256 mismatch: ${url}`);
}


export async function publishAssetGroup({tag,files,repo,stage}, {callApi=api, upload=args=>gh(args), verify=downloadVerified}={}) {
  // Unpublished drafts may have no Git tag yet, so the by-tag endpoint can return 404.
  let release=callApi(`repos/${WEBSITE_RELEASE_REPO}/releases?per_page=100`).find(item=>item.tag_name===tag);
  if (!release) {
    const changelog=JSON.parse(readFileSync(join(PATHS.site,'src/changelog.json'),'utf8'));
    const changes=tag.startsWith('agentd-')?[]:changelog.releases.find(item=>`v${item.version}`===tag)?.changes||[];
    release=callApi(`repos/${WEBSITE_RELEASE_REPO}/releases`,{tag_name:tag,target_commitish:repo.default_branch,name:tag.startsWith('agentd-')?`Larry Agent agentd ${tag.slice(7)}`:`Larry Agent ${tag}`,draft:true,body:[`Official downloads for https://larryagent.online/.`,...changes.map(copy=>`- ${copy}`),'','Verify downloaded files using the attached SHA256SUMS.'].join('\n')});
  }
  const checksumDir=join(stage,tag);mkdirSync(checksumDir,{recursive:true});
  const sums=join(checksumDir,'SHA256SUMS');
  writeFileSync(sums,files.map(asset=>`${asset.sha}  ${asset.entry.file}\n`).join(''));
  const uploads=[...files.map(asset=>({name:asset.entry.file,path:asset.path,sha:asset.sha})),{name:'SHA256SUMS',path:sums,sha:await hashStream(createReadStream(sums))}];
  for (const file of uploads) {
    const existing=release.assets.find(asset=>asset.name===file.name);
    if (existing) {
      if (existing.digest !== `sha256:${file.sha}` || existing.size !== statSync(file.path).size) throw new Error(`Existing ${tag}/${file.name} has different bytes; publish a new version instead of overwriting it.`);
      continue;
    }
    if (!release.draft) throw new Error(`Published ${tag} is incomplete; refusing to change an already published release.`);
    console.log(`Uploading ${tag}/${file.name}`);
    upload(['release','upload',tag,file.path,'--repo',WEBSITE_RELEASE_REPO]);
  }
  // Re-read GitHub's digests before publication; the website is updated last.
  release=callApi(`repos/${WEBSITE_RELEASE_REPO}/releases/${release.id}`);
  for (const file of uploads) if (!release.assets.some(asset=>asset.name===file.name&&asset.digest===`sha256:${file.sha}`)) throw new Error(`GitHub asset verification failed: ${file.name}`);
  if (release.draft) callApi(`repos/${WEBSITE_RELEASE_REPO}/releases/${release.id}`,{draft:false,make_latest:tag.startsWith('agentd-')?'false':'true'},'PATCH');
  for (const asset of files) {
    console.log(`Verifying public download ${tag}/${asset.entry.file}`);
    await verify(asset.url,asset.sha);
  }
  console.log(`Published and verified ${tag}`);
}

export async function publishWebsiteRelease({fromLive=false, createRepo=false, dryRun=false}={}) {
  const localManifest=JSON.parse(readFileSync(join(PATHS.site,'downloads.json'),'utf8'));
  let manifest=localManifest;
  if (fromLive) {
    const response=await fetch('https://larryagent.online/download/downloads.json',{signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error('Cannot read current public installer manifest');
    manifest=await response.json();
  }
  const assets=websiteReleaseAssets(manifest);
  if (dryRun) { console.log(JSON.stringify(makeWebsiteDownloads(manifest),null,2)); return; }
  const user=api('user');
  if (user.login !== WEBSITE_RELEASE_REPO.split('/')[0]) throw new Error(`Sign in to GitHub as ${WEBSITE_RELEASE_REPO.split('/')[0]}`);
  let repo;
  try {repo=api(`repos/${WEBSITE_RELEASE_REPO}`);} catch(error) {
    if (!createRepo || !error.message.includes('404')) throw error;
    repo=api('user/repos',{name:WEBSITE_RELEASE_REPO.split('/')[1],description:'Official Larry Agent installers for larryagent.online. Source code: yujeeloo-hue/LarryAgent.',private:false,auto_init:true,has_issues:false,has_projects:false,has_wiki:false});
    console.log(`Created public release repository: ${repo.html_url}`);
  }
  if (repo.private || repo.full_name !== WEBSITE_RELEASE_REPO) throw new Error('Website downloads require the configured public release repository');
  const stage=mkdtempSync(join(tmpdir(),'larry-website-release-'));
  for (const asset of assets) {
    const local=join(asset.key==='agentd'?PATHS.agentdDist:PATHS.release,asset.entry.file);
    if (fromLive) {
      const cache=join(PATHS.reportDir,'website-assets',asset.sha);mkdirSync(cache,{recursive:true});
      asset.path=join(cache,asset.entry.file);
      if (!existsSync(asset.path) || await hashStream(createReadStream(asset.path)) !== asset.sha) {
        console.log(`Copying current public ${asset.key} installer with pinned SHA256`);
        await downloadVerified(`https://larryagent.online/download/${asset.entry.file}`,asset.sha,asset.path+'.part');
        renameSync(asset.path+'.part',asset.path);
      }
    } else {
      if (!existsSync(local) || await hashStream(createReadStream(local)) !== asset.sha) throw new Error(`Local installer differs from manifest: ${local}. Rebuild its manifest or use --from-live to migrate current public files.`);
      asset.path=local;
    }
  }
  const groups=new Map();
  for (const asset of assets) groups.set(asset.tag,[...(groups.get(asset.tag)||[]),asset]);
  for (const [tag,files] of groups) await publishAssetGroup({tag,files,repo,stage});
  const target=join(PATHS.site,'website-downloads.json');
  const sizes=Object.fromEntries(assets.map(asset=>[asset.key,statSync(asset.path).size]));
  writeFileSync(target+'.new',JSON.stringify(makeWebsiteDownloads(manifest,sizes),null,2)+'\n');
  renameSync(target+'.new',target);
  console.log('Website download manifest ready. Existing updater manifests were not modified.');
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const args=process.argv.slice(2);
  const allowed=['--from-live','--create-repo','--dry-run'];
  if (args.some(arg=>!allowed.includes(arg))) throw new Error(`Usage: node scripts/publish-website-release.mjs [${allowed.join('] [')}]`);
  await publishWebsiteRelease({fromLive:args.includes('--from-live'),createRepo:args.includes('--create-repo'),dryRun:args.includes('--dry-run')});
}
