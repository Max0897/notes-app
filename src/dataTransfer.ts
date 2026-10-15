type ExportFile = {name: string; text: string};
// ZIP STORE: UTF-8 filenames, CRC32 and no compression; no extra browser dependency.
export function zipFiles(files: ExportFile[]): Uint8Array {
  const encoder = new TextEncoder(), chunks: Uint8Array[] = [], directory: Uint8Array[] = [];
  let offset = 0;
  const crc32 = (bytes: Uint8Array) => { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ -1) >>> 0; };
  for (const file of files) {
    const name = encoder.encode(file.name), data = encoder.encode(file.text), crc = crc32(data);
    const local = new Uint8Array(30 + name.length), view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true); view.setUint16(12, 33, true);
    view.setUint32(14, crc, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true); view.setUint16(26, name.length, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.length), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true); cv.setUint16(14, 33, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); central.set(name, 46);
    chunks.push(local, data); directory.push(central); offset += local.length + data.length;
  }
  const directorySize = directory.reduce((sum, bytes) => sum + bytes.length, 0), end = new Uint8Array(22), view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true); view.setUint16(10, files.length, true); view.setUint32(12, directorySize, true); view.setUint32(16, offset, true);
  const result = new Uint8Array(offset + directorySize + end.length); let at = 0;
  for (const chunk of [...chunks, ...directory, end]) { result.set(chunk, at); at += chunk.length; }
  return result;
}
export function downloadFiles(files: ExportFile[]) {
  const blob = files.length === 1 ? new Blob([files[0].text], {type: 'text/plain;charset=utf-8'}) : new Blob([zipFiles(files) as Uint8Array<ArrayBuffer>], {type: 'application/zip'});
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = files.length === 1 ? files[0].name : '备忘录导出.zip'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
