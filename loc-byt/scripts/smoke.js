#!/usr/bin/env node
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const BFF = process.env.BFF_URL || 'http://localhost:3001';
const EMAIL = process.env.SMOKE_EMAIL || 'admin@bytspot.ai';
const PASS = process.env.SMOKE_PASS || 'S3cret!';

async function main(){
  console.log('BFF:', BFF);
  const reg = await fetch(`${BFF}/api/auth/register`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:EMAIL,password:PASS})});
  console.log('register status', reg.status);

  const login = await fetch(`${BFF}/api/auth/login`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:EMAIL,password:PASS})});
  const d = await login.json();
  if(!login.ok||!d.access_token){ throw new Error('login failed'); }
  const token = d.access_token;
  console.log('login ok');

  // promote (dev helper)
  try {
    const p = await fetch(`http://localhost:8090/dev/promote-admin`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:EMAIL})});
    console.log('promote status', p.status);
  } catch(e){ console.log('promote skipped:', e.message); }

  const sess = await fetch(`${BFF}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` }});
  console.log('session status', sess.status);
  const onboardingPost = await fetch(`${BFF}/api/host/onboarding`, { method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`}, body: JSON.stringify({ serviceType: 'venue', progress: 30, data: { step: 'service-type'} }) });
  console.log('onboarding post status', onboardingPost.status);
  const onboardingGet = await fetch(`${BFF}/api/host/onboarding`, { headers:{ Authorization:`Bearer ${token}` } });
  console.log('onboarding get status', onboardingGet.status);
  console.log('onboarding get body', await onboardingGet.text());
}

main().catch((e)=>{ console.error(e); process.exit(1); });

