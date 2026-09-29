const crypto = require('node:crypto');
function extensionId(key) { return crypto.createHash('sha256').update(key).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c => String.fromCharCode(97 + parseInt(c,16))); }
// CRX3 headers use only varints and length-delimited protobuf fields.
function fields(buffer) {
  let offset = 0;
  const number = () => { let value = 0, shift = 0; for (let i=0;i<5;i++) { if (offset >= buffer.length) throw new Error('Truncated CRX header.'); const byte=buffer[offset++]; value += (byte & 127) * 2 ** shift; if (!(byte & 128)) return value; shift += 7; } throw new Error('Invalid CRX header integer.'); };
  const result = [];
  while(offset < buffer.length) {
    const tag=number(), type=tag & 7;
    if (type === 0) { number(); continue; }
    if (type !== 2) throw new Error('Unsupported CRX header encoding.');
    const length=number(); if (offset+length>buffer.length) throw new Error('Truncated CRX header field.');
    result.push([Math.floor(tag/8),buffer.subarray(offset,offset+length)]); offset += length;
  }
  return result;
}
function verifiedZip(crx, expectedId) {
  if (crx.length < 12 || crx.toString('ascii',0,4) !== 'Cr24' || crx.readUInt32LE(4) !== 3) throw new Error('Invalid Chrome extension archive.');
  const offset = 12 + crx.readUInt32LE(8);
  if (offset >= crx.length) throw new Error('Invalid Chrome extension header.');
  const header=fields(crx.subarray(12,offset));
  const signedHeaders=header.filter(([tag])=>tag===10000);
  if (signedHeaders.length !== 1) throw new Error('Missing CRX signature header.');
  const signed=signedHeaders[0][1], crxId=fields(signed).find(([tag])=>tag===1)?.[1];
  if (!crxId || crxId.toString('hex').replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16))) !== expectedId) throw new Error('Unexpected extension identity.');
  const length=Buffer.alloc(4); length.writeUInt32LE(signed.length);
  const data=Buffer.concat([Buffer.from('CRX3 SignedData\0'),length,signed,crx.subarray(offset)]);
  for (const [tag,proof] of header) {
    if (![2,3].includes(tag)) continue;
    const parts=fields(proof), key=parts.find(([n])=>n===1)?.[1], signature=parts.find(([n])=>n===2)?.[1];
    if (key && signature && extensionId(key) === expectedId && crypto.verify('sha256',data,{key,format:'der',type:'spki'},signature)) return crx.subarray(offset);
  }
  throw new Error('Claude extension signature verification failed.');
}
module.exports={extensionId,verifiedZip};
