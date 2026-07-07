import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultHtmlPath = path.resolve(here, '../../../dist/islandmilfcode/index.html');
const htmlPath = path.resolve(process.argv[2] ?? defaultHtmlPath);

function countMatches(text, pattern) {
  return (text.match(pattern) ?? []).length;
}

function extractInlineScripts(html) {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1] ?? '');
}

const LEGACY_ENTITY_PREFIXES = [
  'AElig',
  'AMP',
  'Aacute',
  'Acirc',
  'Agrave',
  'Aring',
  'Atilde',
  'Auml',
  'COPY',
  'Ccedil',
  'ETH',
  'Eacute',
  'Ecirc',
  'Egrave',
  'Euml',
  'GT',
  'Iacute',
  'Icirc',
  'Igrave',
  'Iuml',
  'LT',
  'Ntilde',
  'QUOT',
  'REG',
  'THORN',
  'Uacute',
  'Ucirc',
  'Ugrave',
  'Uuml',
  'Yacute',
  'aacute',
  'acirc',
  'acute',
  'aelig',
  'agrave',
  'amp',
  'aring',
  'atilde',
  'auml',
  'brvbar',
  'ccedil',
  'cedil',
  'cent',
  'copy',
  'curren',
  'deg',
  'divide',
  'eacute',
  'ecirc',
  'egrave',
  'eth',
  'euml',
  'frac12',
  'frac14',
  'frac34',
  'gt',
  'iacute',
  'icirc',
  'iexcl',
  'igrave',
  'iquest',
  'iuml',
  'laquo',
  'lt',
  'macr',
  'micro',
  'middot',
  'nbsp',
  'not',
  'ntilde',
  'oacute',
  'ocirc',
  'ograve',
  'ordf',
  'ordm',
  'oslash',
  'otilde',
  'ouml',
  'para',
  'plusmn',
  'pound',
  'quot',
  'raquo',
  'reg',
  'sect',
  'shy',
  'sup1',
  'sup2',
  'sup3',
  'szlig',
  'thorn',
  'times',
  'uacute',
  'ucirc',
  'ugrave',
  'uuml',
  'yacute',
  'yen',
  'yuml',
];

const legacyEntityPrefixPattern = new RegExp(`&(?:${LEGACY_ENTITY_PREFIXES.join('|')})(?=[A-Za-z0-9_$])`, 'g');

function stripTopLevelImports(script) {
  return script.replace(/^\s*(?:import[\s\S]*?;\s*)+/, '');
}

function checkScriptSyntax(label, script) {
  try {
    new vm.Script(stripTopLevelImports(script), { filename: label });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function summarizeRisk(html) {
  return {
    evalCount: countMatches(html, /eval\(/g),
    inlineSourceMap: countMatches(html, /sourceMappingURL=data:/g),
    webpackInternalSourceUrl: countMatches(html, /sourceURL=webpack-internal/g),
    dollarExport: countMatches(html, /[$][A-Za-z0-9_$]*\s*:\s*\(\)\s*=>/g),
    emptyExport: countMatches(html, /[,{]\s*:\s*\(\)\s*=>/g),
    replacementSpecial: countMatches(html, /[$](?:[0-9]|[&`'$]|<)/g),
    legacyEntityPrefix: countMatches(html, legacyEntityPrefixPattern),
    currencySign: countMatches(html, /¤/g),
    replacementChar: countMatches(html, /�/g),
    hasFullPlotExport: html.includes('buildPlotMachinePromptBlock:()=>buildPlotMachinePromptBlock'),
  };
}

function fail(message, details) {
  console.error(`[host-bundle-safety] FAIL: ${message}`);
  if (details) console.error(JSON.stringify(details, null, 2));
  process.exitCode = 1;
}

if (!fs.existsSync(htmlPath)) {
  fail(`HTML file not found: ${htmlPath}`);
} else {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const replacedHtml = 'X'.replace(/X/, html);
  const entityDecodedHtml = html.replace(legacyEntityPrefixPattern, '¤');
  const scripts = extractInlineScripts(html);
  const replacedScripts = extractInlineScripts(replacedHtml);
  const entityDecodedScripts = extractInlineScripts(entityDecodedHtml);
  const originalRisk = summarizeRisk(html);
  const replacedRisk = summarizeRisk(replacedHtml);
  const entityDecodedRisk = summarizeRisk(entityDecodedHtml);

  const syntaxErrors = [
    ...scripts.map((script, index) => [`inline-${index}.js`, checkScriptSyntax(`inline-${index}.js`, script)]),
    ...replacedScripts.map((script, index) => [
      `inline-${index}.after-replace.js`,
      checkScriptSyntax(`inline-${index}.after-replace.js`, script),
    ]),
    ...entityDecodedScripts.map((script, index) => [
      `inline-${index}.after-legacy-entity-decode.js`,
      checkScriptSyntax(`inline-${index}.after-legacy-entity-decode.js`, script),
    ]),
  ].filter(([, error]) => error);

  const changedByReplacement = html !== replacedHtml || scripts.join('\n') !== replacedScripts.join('\n');
  const changedByLegacyEntityDecode =
    html !== entityDecodedHtml || scripts.join('\n') !== entityDecodedScripts.join('\n');
  const riskyCounts = {
    evalCount: originalRisk.evalCount,
    inlineSourceMap: originalRisk.inlineSourceMap,
    webpackInternalSourceUrl: originalRisk.webpackInternalSourceUrl,
    dollarExport: originalRisk.dollarExport,
    emptyExport: originalRisk.emptyExport,
    replacementSpecial: originalRisk.replacementSpecial,
    legacyEntityPrefix: originalRisk.legacyEntityPrefix,
    currencySign: originalRisk.currencySign,
    replacementChar: originalRisk.replacementChar,
    replacedEmptyExport: replacedRisk.emptyExport,
    entityDecodedCurrencySign: entityDecodedRisk.currencySign,
  };

  if (scripts.length === 0) fail('No inline scripts found', { htmlPath });
  if (changedByReplacement) fail('HTML changes when used as a String.replace replacement value');
  if (changedByLegacyEntityDecode) fail('HTML changes when legacy HTML entity prefixes are decoded');
  if (Object.values(riskyCounts).some(count => count !== 0)) fail('Bundle contains host-unsafe generated tokens', riskyCounts);
  if (html.includes("id:'v07'") && !originalRisk.hasFullPlotExport) {
    fail('V07 plot machine is bundled, but plot-state-machine exports are not preserved by name');
  }
  if (syntaxErrors.length > 0) fail('Inline script syntax check failed', Object.fromEntries(syntaxErrors));

  if (!process.exitCode) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          htmlPath,
          inlineScripts: scripts.length,
          originalLength: html.length,
          replacedLength: replacedHtml.length,
          checks: originalRisk,
        },
        null,
        2,
      ),
    );
  }
}
