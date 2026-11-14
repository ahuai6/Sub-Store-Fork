// Same release-time mihomo pin upstream applies in .github/workflows/main.yml
// before bundling. Kept as its own script so the public publish build and a
// local release-equivalent build share one implementation.
import fs from 'node:fs';

const version = process.env.MIHOMO_VERSION;
if (!version) {
    throw new Error('MIHOMO_VERSION is required');
}

const files = ['src/utils/download.js', 'src/utils/flow.js'];
let replacements = 0;

for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const next = source.replace(/clash\.meta\/[^"']+/g, () => {
        replacements += 1;
        return `clash.meta/${version}`;
    });

    if (next !== source) {
        fs.writeFileSync(file, next);
    }
}

if (replacements === 0) {
    throw new Error('No clash.meta version strings were updated.');
}

console.log(`Updated ${replacements} clash.meta version string(s) to ${version}.`);
