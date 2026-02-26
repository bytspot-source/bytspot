const cp = require('child_process');
const opts = { cwd: 'C:\\Users\\godmo', stdio: 'inherit' };
cp.execSync('git add .augment/bytspot-api/', opts);
cp.execSync('git commit -m "fix: auto-seed on first deploy, re-apply PostGIS migration on pro tier, move tsx to deps"', opts);
cp.execSync('git push origin beta-funnel/deploy', opts);
