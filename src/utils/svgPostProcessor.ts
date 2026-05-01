import { optimize, Config } from 'svgo';
import { transformSvgColors } from './colorTransform';

const SVGO_CONFIG: Config = {
    plugins: [{
        name: 'preset-default',
        params: {
            overrides: {
                cleanupIds: false,
                removeViewBox: false,
                convertPathData: false,
                mergePaths: false,
                convertTransform: false,
                convertShapeToPath: false,
            }
        }
    }]
};

export function postProcessSvg(svg: string, darkMode: boolean): string {
    try {
        const optimized = fixSvgDimensions(optimize(svg, SVGO_CONFIG).data);
        return transformSvgColors(optimized, darkMode);
    } catch {
        return transformSvgColors(svg, darkMode);
    }
}

function fixSvgDimensions(svg: string): string {
    const viewBoxMatch = svg.match(/viewBox="([^"]+)"/);
    if (!viewBoxMatch) { return svg; }
    const parts = viewBoxMatch[1].trim().split(/\s+/);
    if (parts.length !== 4) { return svg; }
    let result = svg.replace(/(<svg[^>]*?\s)width="[^"]*"/, `$1width="${parts[2]}pt"`);
    result = result.replace(/(<svg[^>]*?\s)height="[^"]*"/, `$1height="${parts[3]}pt"`);
    return result;
}
