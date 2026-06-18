/**
 * Cubase Expression Map parser — zero dependencies, pure Node built-ins.
 *
 * Parses the Cubase .expressionmap XML format which looks like:
 *   <InstrumentMap name="NAME">
 *     <member name="slots">
 *       <list ...>
 *         <obj class="InstrumentMapSlot" ...>
 *           <member name="name"><string value="Long"/></member>
 *           <member name="outputs">
 *             <list ...>
 *               <obj class="InstrumentMapOutput" ...>
 *                 <member name="type"><int value="0"/></member>
 *                 <member name="data1"><int value="60"/></member>
 *                 <member name="data2"><int value="127"/></member>
 *                 <member name="channel"><int value="0"/></member>
 *               </obj>
 *             </list>
 *           </member>
 *         </obj>
 *       </list>
 *     </member>
 *   </InstrumentMap>
 */

const fs   = require('fs');
const path = require('path');

const OUTPUT_TYPES = { 0: 'note', 1: 'cc', 2: 'pc', 3: 'pitchbend' };

// Pull the value attribute out of a self-closing <string value="..."/> or <int value="..."/>
// that follows a <member name="TARGET"> tag.
function extractMemberValue(xml, memberName) {
  // Match the member tag, then greedily find the first value= inside it before </member> or next <member
  const memberRe = new RegExp(
    `<member\\s+name="${memberName}"[^>]*>\\s*<(?:string|int)\\s+value="([^"]*)"`,
    'i'
  );
  const m = xml.match(memberRe);
  return m ? m[1] : null;
}

// Split XML into top-level <obj> blocks by finding matching open/close tags.
function splitObjBlocks(xml, objClass) {
  const blocks = [];
  const openTag = new RegExp(`<obj[^>]*class="${objClass}"[^>]*>`, 'g');
  let match;

  while ((match = openTag.exec(xml)) !== null) {
    const start = match.index;
    let depth = 1;
    let i = match.index + match[0].length;

    while (i < xml.length && depth > 0) {
      if (xml[i] === '<') {
        if (xml[i + 1] === '/') {
          // closing tag
          const close = xml.indexOf('>', i);
          depth--;
          i = close + 1;
        } else {
          // opening tag — check if self-closing
          const close = xml.indexOf('>', i);
          const tag = xml.slice(i, close + 1);
          if (!tag.endsWith('/>')) depth++;
          i = close + 1;
        }
      } else {
        i++;
      }
    }

    blocks.push(xml.slice(start, i));
  }

  return blocks;
}

function parseOutputBlock(outputXml) {
  const typeVal  = parseInt(extractMemberValue(outputXml, 'type')    ?? '0', 10);
  const data1Val = parseInt(extractMemberValue(outputXml, 'data1')   ?? '0', 10);
  const data2Val = parseInt(extractMemberValue(outputXml, 'data2')   ?? '127', 10);
  const chVal    = parseInt(extractMemberValue(outputXml, 'channel') ?? '0', 10);

  return {
    type:    OUTPUT_TYPES[typeVal] ?? 'note',
    data1:   isNaN(data1Val) ? 0   : data1Val,
    data2:   isNaN(data2Val) ? 127 : data2Val,
    channel: isNaN(chVal)    ? 0   : chVal,
  };
}

function parseSlotBlock(slotXml) {
  const name = extractMemberValue(slotXml, 'name') ?? 'Unnamed';

  // Find the outputs member section
  const outsMemberMatch = slotXml.match(/<member\s+name="outputs"[^>]*>([\s\S]*?)<\/member>/i);
  const outsXml = outsMemberMatch ? outsMemberMatch[1] : '';
  const outputBlocks = splitObjBlocks(outsXml, 'InstrumentMapOutput');
  const outputs = outputBlocks.map(parseOutputBlock);

  return { name, outputs };
}

function parseExpressionMap(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Extract instrument name from root tag
  const rootMatch = content.match(/<InstrumentMap\s+name="([^"]*)"/i);
  if (!rootMatch) {
    throw new Error(`Not a valid Cubase expression map: ${path.basename(filePath)}`);
  }
  const name = rootMatch[1] || path.basename(filePath, '.expressionmap');

  const slotBlocks  = splitObjBlocks(content, 'InstrumentMapSlot');
  const articulations = slotBlocks
    .map(parseSlotBlock)
    .filter(a => a.name && a.name !== 'Unnamed');

  return { name, filePath, articulations };
}

module.exports = { parseExpressionMap };
