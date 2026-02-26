const cp = require('child_process');
const opts = { cwd: 'C:\\Users\\godmo', stdio: 'inherit' };
cp.execSync('git add .augment/bytspot-api/', opts);
cp.execSync('git commit -m "fix: force re-apply PostGIS migration after DB plan upgrade"', opts);
cp.execSync('git push origin beta-funnel/deploy', opts);
