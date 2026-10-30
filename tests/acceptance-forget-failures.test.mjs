import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const source = new URL('../src/social/index.js', import.meta.url).href
const tracerSource = new URL('../src/skills/tracer.js', import.meta.url).href
const reviewSource = new URL('../src/skills/review-store.js', import.meta.url).href
const messagingSource = new URL('../src/messaging.js', import.meta.url).href
const stateSource = new URL('../src/state.js', import.meta.url).href
const dslSource = new URL('../src/skills/dsl-executor.js', import.meta.url).href
const providerSource = new URL('../src/model-provider.js', import.meta.url).href
const rateSource = new URL('../src/rate-limit.js', import.meta.url).href
const aiSource = new URL('../src/ai.js', import.meta.url).href
const scope = { platform: 'wechat', accountId: 'acceptance-bot', conversationId: 'private:fixture-user', personaId: 'A', subjectId: 'fixture-user' }

function isolated(code, { timeout = 10000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-acceptance-'))
  const configFile = path.join(root, 'config.json')
  fs.writeFileSync(configFile, JSON.stringify({ defaultPersona: 'A', personas: { A: '合成验收角色' }, ai: {}, private: { enabled: true, cooldownSeconds: 0 } }))
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs'; import path from 'node:path';
      import { spawnSync } from 'node:child_process';
      const root=process.env.BOT_DATA_ROOT;
      const scope=${JSON.stringify(scope)};
      const social=await import(${JSON.stringify(source)});
      ${code}
    `], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, BOT_DATA_ROOT: root, BOT_CONFIG_FILE: configFile, BOT_TEST_MODE: '1', BOT_OFFLINE: '1' }, encoding: 'utf8', windowsHide: true, timeout })
    assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout)
    return JSON.parse(child.stdout.trim().split('\n').at(-1))
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('acceptance: a failed migrated-file deletion remains retryable', () => {
  const result = isolated(`
    const original=path.join(root,'memories','private','fixture-user.json');
    fs.mkdirSync(path.dirname(original),{recursive:true});
    fs.writeFileSync(original,JSON.stringify({facts:[{text:'合成应删除的背景'}]}));
    social.migrateLegacy({accountId:scope.accountId,defaultPersona:'A'});
    const realRemove=fs.rmSync; let firstRejected=false;
    fs.rmSync=(file,options)=>{if(path.resolve(file)===original) throw new Error('fixture EPERM'); return realRemove(file,options)};
    try {await social.forgetSubject(scope)} catch {firstRejected=true} finally {fs.rmSync=realRemove}
    await social.forgetSubject(scope);
    console.log(JSON.stringify({firstRejected,sourceRemains:fs.existsSync(original),facts:social.getSocialState(scope).memory.facts.length}));
  `)
  assert.equal(result.firstRejected, true)
  assert.equal(result.facts, 0)
  assert.equal(result.sourceRemains, false, 'retry must remove a legacy source whose first unlink failed')
})

test('acceptance: a deletion before first migration cannot be reimported', () => {
  const result = isolated(`
    const original=path.join(root,'memories','private','fixture-user.json');
    fs.mkdirSync(path.dirname(original),{recursive:true});
    fs.writeFileSync(original,JSON.stringify({facts:[{text:'删除前的合成背景'}]}));
    await social.forgetSubject(scope,{allConversations:true});
    social.migrateLegacy({accountId:scope.accountId,defaultPersona:'A'});
    console.log(JSON.stringify({facts:social.getSocialState(scope).memory.facts.length,sourceRemains:fs.existsSync(original)}));
  `)
  assert.equal(result.facts, 0, 'a persisted deletion generation must also exclude legacy import')
  assert.equal(result.sourceRemains, false)
})

test('acceptance: failed trace unlink is surfaced instead of claiming complete forgetting', () => {
  const result = isolated(`
    const tracer=await import(${JSON.stringify(tracerSource)});
    const trace=tracer.recordInteractionTrace({scope,userText:'不要回这么长'});
    const file=path.join(root,'state','proposals',trace.id+'.json');
    const realUnlink=fs.unlinkSync; let rejected=false;
    fs.unlinkSync=(target)=>{if(path.resolve(target)===file) throw new Error('fixture EPERM'); return realUnlink(target)};
    try {tracer.purgeSubjectTraces(scope)} catch {rejected=true} finally {fs.unlinkSync=realUnlink}
    console.log(JSON.stringify({rejected,traceRemains:fs.existsSync(file)}));
  `)
  assert.equal(result.traceRemains, true)
  assert.equal(result.rejected, true, 'UI must receive a cleanup failure while private attribution survives')
})

test('acceptance: candidate cleanup failure is retried after its trace was removed', () => {
  const result = isolated(`
    const tracer=await import(${JSON.stringify(tracerSource)});
    const review=await import(${JSON.stringify(reviewSource)});
    const trace=tracer.recordInteractionTrace({scope,userText:'不要回这么长'});
    const candidate=tracer.generateCandidateFromTrace(trace.id);
    const file=path.join(root,'state','skills','candidates',candidate.id+'.json');
    const realRemove=fs.rmSync; let rejected=false;
    fs.rmSync=(target,options)=>{if(path.resolve(target)===file) throw new Error('fixture EPERM'); return realRemove(target,options)};
    try {tracer.purgeSubjectTraces(scope)} catch {rejected=true} finally {fs.rmSync=realRemove}
    tracer.purgeSubjectTraces(scope);
    console.log(JSON.stringify({rejected,candidateRemains:fs.existsSync(file)}));
  `)
  assert.equal(result.rejected, true)
  assert.equal(result.candidateRemains, false, 'retry must retain enough attribution to purge the orphaned candidate')
})

test('acceptance: UI-style cross-process forget also deletes persisted pending delivery attribution', () => {
  const result = isolated(`
    const {createMessagingRuntime}=await import(${JSON.stringify(messagingSource)});
    const conf=JSON.parse(fs.readFileSync(process.env.BOT_CONFIG_FILE,'utf8'));
    const runtime=createMessagingRuntime({conf,socialApi:{...social,commitInteraction:async()=>{throw new Error('fixture journal outage')}},personaName:()=> 'A',sleep:async()=>{}});
    const msg={id:'delivery-one',self:()=>false,text:()=> '谢谢，代码问题解决了',wechaty:{currentUser:{id:scope.accountId}},talker:()=>({id:scope.subjectId,name:()=> '合成昵称',alias:async()=>'',self:()=>false}),say:async()=>{}};
    await runtime.process({msg,producer:async()=> '确认发送'});
    const child=spawnSync(process.execPath,['--input-type=module','-e',
      'const s=await import('+JSON.stringify(${JSON.stringify(source)})+'); await s.forgetSubject('+JSON.stringify(scope)+');'],
      {env:process.env,encoding:'utf8',windowsHide:true,timeout:10000});
    if(child.status!==0) throw new Error(child.stderr);
    const pending=Object.values(JSON.parse(fs.readFileSync(path.join(root,'state','message-outbox.json'),'utf8')).messages).filter(row=>row.socialPending);
    runtime.dispose(); console.log(JSON.stringify({pending:pending.length}));
  `)
  assert.equal(result.pending, 0, 'cross-process UI deletion must erase source attribution on disk without waiting for another bot message')
})

test('acceptance: changing one migrated role preserves all other frozen selections', () => {
  const result = isolated(`
    fs.mkdirSync(path.join(root,'state'),{recursive:true});
    fs.writeFileSync(path.join(root,'state','personas.json'),JSON.stringify({rooms:{one:'B',two:'B'},private:{'private-other':'B'}}));
    social.migrateLegacy({accountId:scope.accountId,defaultPersona:'A'});
    const state=await import(${JSON.stringify(stateSource)});
    const room={accountId:scope.accountId,scope:'room',roomId:'two'};
    const before=state.getPersonaName(room,'A');
    state.setPersonaName({accountId:scope.accountId,scope:'room',roomId:'one'},'C');
    const privateScope={accountId:scope.accountId,scope:'private',userId:'private-other'};
    const after=state.getPersonaName(room,'A'), privateAfter=state.getPersonaName(privateScope,'A');
    state.clearPersona(room); state.clearPersona(privateScope);
    const resetRoom=state.getPersonaName(room,'A'),resetPrivate=state.getPersonaName(privateScope,'A');
    const child=spawnSync(process.execPath,['--input-type=module','-e',
      'const state=await import('+JSON.stringify(${JSON.stringify(stateSource)})+'); console.log(JSON.stringify({room:state.getPersonaName('+JSON.stringify(room)+',"A"),private:state.getPersonaName('+JSON.stringify(privateScope)+',"A")}));'],
      {env:process.env,encoding:'utf8',windowsHide:true,timeout:10000});
    if(child.status!==0) throw new Error(child.stderr);
    console.log(JSON.stringify({before,after,privateAfter,resetRoom,resetPrivate,restarted:JSON.parse(child.stdout.trim())}));
  `)
  assert.equal(result.before, 'B')
  assert.equal(result.after, 'B', 'first role change must not erase the other migrated room selections')
  assert.equal(result.privateAfter, 'B')
  assert.equal(result.resetRoom, 'A', 'explicit reset must override the migrated room role')
  assert.equal(result.resetPrivate, 'A', 'explicit reset must override the migrated private role')
  assert.deepEqual(result.restarted, { room: 'A', private: 'A' }, 'explicit reset must survive a process restart')
})

test('acceptance: optional-token regex cannot block candidate review past its deadline', () => {
  isolated(`
    const {compileSafeRegex}=await import(${JSON.stringify(dslSource)});
    let rejected=false;
    try {compileSafeRegex('a?'.repeat(45)+'a'.repeat(45)+'b').test('a'.repeat(45))} catch {rejected=true}
    console.log(JSON.stringify({rejected}));
  `, { timeout: 1500 })
})

test('acceptance: local-only model provider refuses a redirect response', () => {
  const result = isolated(`
    const {createOllamaProvider}=await import(${JSON.stringify(providerSource)});
    const fetchImpl=async(_url,init)=>{
      if(init.redirect==='error') throw new TypeError('redirect disallowed');
      if(init.redirect==='manual') return new Response('',{status:307,headers:{Location:'https://remote.example/model'}});
      return new Response(JSON.stringify({message:{content:'simulated body sent to redirected remote'}}));
    };
    const provider=createOllamaProvider({ai:{model:'fixture',baseUrl:'http://127.0.0.1:11434'}},{fetchImpl});
    let rejected=false;
    try {await provider.generate({messages:[{role:'user',content:'合成私人上下文'}]})} catch {rejected=true}
    console.log(JSON.stringify({rejected}));
  `)
  assert.equal(result.rejected, true, 'local endpoint validation must hold across HTTP redirects')
})

test('acceptance: crash between quota reservation and outbox association releases the orphan hold', () => {
  const result = isolated(`
    const {createRateLimiter}=await import(${JSON.stringify(rateSource)});
    const {createMessagingRuntime,conversationKey}=await import(${JSON.stringify(messagingSource)});
    const conf=JSON.parse(fs.readFileSync(process.env.BOT_CONFIG_FILE,'utf8'));
    const file=path.join(root,'state','rate-limit.json');
    const rate=createRateLimiter({file});
    const key=conversationKey(scope);
    rate.reserve([{key,dailyLimit:1,cooldownSeconds:0}]);
    fs.writeFileSync(path.join(root,'state','message-outbox.json'),JSON.stringify({version:1,messages:{'queued-before-reserve':{status:'queued',at:Date.now(),confirmedCount:0,kind:'text'}}}));
    const runtime=createMessagingRuntime({conf,personaName:()=> 'A'});
    await runtime.ready();
    console.log(JSON.stringify({allowed:runtime.limiter.check(key,0,1).allowed,holds:Object.keys(runtime.limiter.snapshot().holds).length}));
    runtime.dispose();
  `)
  assert.equal(result.allowed, true, 'a response that never reached generation must not strand the daily quota')
  assert.equal(result.holds, 0)
})

test('acceptance: cross-process forget prevents a correction trace after an earlier epoch read', () => {
  const result = isolated(`
    const ai=await import(${JSON.stringify(aiSource)});
    const tracer=await import(${JSON.stringify(tracerSource)});
    ai.initAi({defaultPersona:'A',personas:{A:'合成验收角色'},ai:{model:'fixture'}},
      {provider:{generate:async()=>({text:'合成回复'})}});
    social.recordObservation({scope,sourceId:'initialize-journal',facts:[],epoch:social.captureEpoch(scope)});
    const epoch=social.captureEpoch(scope);
    const journal=path.join(root,'state','social','journal.json');
    const realRead=fs.readFileSync; let didForget=false;
    fs.readFileSync=(file,...args)=>{
      const content=realRead(file,...args);
      if(!didForget && typeof file==='string' && path.resolve(file)===journal){
        didForget=true;
        const child=spawnSync(process.execPath,['--input-type=module','-e',
          'const s=await import('+JSON.stringify(${JSON.stringify(source)})+'); const t=await import('+JSON.stringify(${JSON.stringify(tracerSource)})+'); const scope='+JSON.stringify(scope)+'; await s.forgetSubject(scope); t.purgeSubjectTraces(scope);'],
          {env:process.env,encoding:'utf8',windowsHide:true,timeout:5000});
        if(child.status!==0) throw new Error(child.error?.message || child.stderr);
      }
      return content;
    };
    let reply;
    try {reply=await ai.chat({key:'acceptance-correction-race',userText:'不要回这么长',scope,epoch})}
    finally {fs.readFileSync=realRead}
    console.log(JSON.stringify({didForget,reply,traces:tracer.listInteractionTraces().length,current:social.isEpochCurrent(scope,epoch)}));
  `, { timeout: 15000 })
  assert.equal(result.didForget, true, 'the fixture must complete a real cross-process deletion at the old-read boundary')
  assert.equal(result.current, false)
  assert.equal(result.reply, null)
  assert.equal(result.traces, 0, 'a correction classified from an old generation must not recreate forgotten attribution')
})

test('acceptance: a cached trace cannot create a candidate after cross-process forgetting', () => {
  const result = isolated(`
    const tracer=await import(${JSON.stringify(tracerSource)});
    const review=await import(${JSON.stringify(reviewSource)});
    const trace=tracer.recordInteractionTrace({scope,userText:'不要回这么长',epoch:social.captureEpoch(scope)});
    if(!trace) throw new Error('fixture trace was not recorded');
    const traceFile=path.join(root,'state','proposals',trace.id+'.json');
    const realRead=fs.readFileSync; let didForget=false, rejected=false;
    fs.readFileSync=(file,...args)=>{
      const content=realRead(file,...args);
      if(!didForget && typeof file==='string' && path.resolve(file)===traceFile){
        didForget=true;
        const child=spawnSync(process.execPath,['--input-type=module','-e',
          'const s=await import('+JSON.stringify(${JSON.stringify(source)})+'); const t=await import('+JSON.stringify(${JSON.stringify(tracerSource)})+'); const scope='+JSON.stringify(scope)+'; await s.forgetSubject(scope); t.purgeSubjectTraces(scope);'],
          {env:process.env,encoding:'utf8',windowsHide:true,timeout:5000});
        if(child.status!==0) throw new Error(child.error?.message || child.stderr);
      }
      return content;
    };
    try {tracer.generateCandidateFromTrace(trace.id)} catch {rejected=true} finally {fs.readFileSync=realRead}
    console.log(JSON.stringify({didForget,rejected,traceRemains:fs.existsSync(traceFile),candidates:review.listSkillReviews().candidates.length}));
  `, { timeout: 15000 })
  assert.equal(result.didForget, true)
  assert.equal(result.traceRemains, false)
  assert.equal(result.candidates, 0, 'a stale in-memory source must not restore a candidate after its subject was forgotten')
})

test('acceptance: forgetting cleans a migration backup written before the manifest commit failed', () => {
  const result = isolated(`
    const original=path.join(root,'memories','private','fixture-user.json');
    fs.mkdirSync(path.dirname(original),{recursive:true});
    fs.writeFileSync(original,JSON.stringify({facts:[{text:'迁移中断前的合成私人背景'}]}));
    const backupDir=path.join(root,'state','social','migration-backup');
    const journal=path.join(root,'state','social','journal.json');
    const countBackups=()=>fs.existsSync(backupDir)?fs.readdirSync(backupDir).filter(name=>name.endsWith('.json')).length:0;
    const realRename=fs.renameSync; let interrupted=false;
    fs.renameSync=(from,to)=>{
      if(!interrupted && path.resolve(to)===journal && countBackups()>0){
        interrupted=true;
        throw new Error('fixture failure after backup and before manifest commit');
      }
      return realRename(from,to);
    };
    let migrationRejected=false;
    try {social.migrateLegacy({accountId:scope.accountId,defaultPersona:'A'})}
    catch {migrationRejected=true} finally {fs.renameSync=realRename}
    const backupsBefore=countBackups();
    await social.forgetSubject(scope);
    social.migrateLegacy({accountId:scope.accountId,defaultPersona:'A'});
    console.log(JSON.stringify({interrupted,migrationRejected,backupsBefore,backupsAfter:countBackups(),sourceRemains:fs.existsSync(original),facts:social.getSocialState(scope).memory.facts.length}));
  `)
  assert.equal(result.interrupted, true, 'the fixture must fail only after the private migration backup exists')
  assert.equal(result.migrationRejected, true)
  assert.ok(result.backupsBefore > 0)
  assert.equal(result.facts, 0)
  assert.equal(result.sourceRemains, false)
  assert.equal(result.backupsAfter, 0, 'pre-commit migration backups must remain attributable and be deleted by forgetting')
})

test('acceptance: forgetting removes interrupted private atomic writes without deleting ordinary files', () => {
  const result = isolated(`
    const socialDir=path.join(root,'state','social');
    const backupDir=path.join(socialDir,'migration-backup');
    const candidatesDir=path.join(root,'state','skills','candidates');
    const proposalsDir=path.join(root,'state','proposals');
    for(const dir of [backupDir,candidatesDir,proposalsDir]) fs.mkdirSync(dir,{recursive:true});
    const stale=JSON.stringify({facts:['应随遗忘删除的旧合成私人背景']});
    const interrupted=[
      path.join(socialDir,'journal.json.987654.0123456789.tmp'),
      path.join(backupDir,'a'.repeat(64)+'.json.987654.abcdef0123.tmp'),
      path.join(candidatesDir,'candidate_fixture.json.01234567-89ab-4cde-8fab-0123456789ab.tmp'),
      path.join(proposalsDir,'trace_fixture.json.01234567-89ab-4cde-8fab-0123456789ab.tmp'),
    ];
    const ordinary=[path.join(backupDir,'unrelated.json'),path.join(candidatesDir,'ordinary.json'),path.join(socialDir,'notes.tmp')];
    for(const file of interrupted) fs.writeFileSync(file,stale);
    for(const file of ordinary) fs.writeFileSync(file,'unrelated fixture must survive');
    await social.forgetSubject(scope);
    console.log(JSON.stringify({remainingInterrupted:interrupted.filter(file=>fs.existsSync(file)).length,
      ordinaryUnchanged:ordinary.every(file=>fs.readFileSync(file,'utf8')==='unrelated fixture must survive')}));
  `)
  assert.equal(result.remainingInterrupted, 0, 'a forgotten snapshot must not survive in abandoned atomic-write temporaries')
  assert.equal(result.ordinaryUnchanged, true, 'privacy cleanup must not delete unrelated ordinary files')
})
