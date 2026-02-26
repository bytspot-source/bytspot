const cp = require('child_process');
const opts = { cwd: 'C:\\Users\\godmo', stdio: 'inherit' };
cp.execSync('git add .augment/bytspot-api/', opts);
cp.execSync('git commit -m "fix: move type defs and build tools to dependencies for Render CI"', opts);
cp.execSync('git push origin beta-funnel/deploy', opts);
