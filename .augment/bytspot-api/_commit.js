const cp = require('child_process');
const opts = { cwd: 'C:\\Users\\godmo', stdio: 'inherit' };
cp.execSync('git add .augment/bytspot-api/', opts);
cp.execSync('git commit -m "fix: defensive PostGIS migration + startup script to resolve failed migrations"', opts);
cp.execSync('git push origin beta-funnel/deploy', opts);
