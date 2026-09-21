/* 딴짓 차단기 - 최소 기능 엑셀(.xlsx) 읽기·쓰기
 *
 * 외부 라이브러리를 쓰지 않는다. (확장 프로그램 정책상 원격 코드 금지,
 * 그리고 흔히 쓰는 라이브러리의 npm 배포판에는 파일을 읽을 때의 보안 취약점이 남아 있다)
 *
 * .xlsx 는 XML 파일 몇 개를 zip 으로 묶은 것이다.
 *   쓰기: 압축하지 않은(STORED) zip 으로 만든다 — 엑셀·구글 시트·넘버스 모두 정상적으로 연다.
 *   읽기: zip 을 풀 때 크롬 내장 DecompressionStream("deflate-raw") 를 쓰고,
 *         XML 은 DOMParser 로 읽는다. 문자열은 공유 문자열·인라인 문자열 모두 지원한다.
 *
 * 사용법
 *   const bytes = XlsxLite.write([{ name: "시트", rows: [["A1", "B1"], ["A2", 3]], widths: [40, 20] }]);
 *   const book  = await XlsxLite.read(arrayBuffer);   // { "시트": [["A1","B1"],["A2","3"]] }
 */
const XlsxLite = (() => {
  /* ---------------- 공통 ---------------- */

  const enc = new TextEncoder();
  const dec = new TextDecoder("utf-8");

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function escXml(v) {
    return String(v)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "") // XML 에 못 넣는 제어문자 제거
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 0 → A, 25 → Z, 26 → AA */
  function colName(i) {
    let s = "";
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
      s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    }
    return s;
  }

  /** "AB12" → 27 */
  function colIndex(ref) {
    const letters = /^[A-Z]+/i.exec(ref || "");
    if (!letters) return -1;
    let n = 0;
    for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  /* ---------------- zip 쓰기 (무압축) ---------------- */

  function zipStore(files) {
    // files: [{ name, data: Uint8Array }]
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);        // 필요한 버전
      lh.setUint16(6, 0x0800, true);    // 파일 이름 UTF-8
      lh.setUint16(8, 0, true);         // 무압축
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      locals.push(new Uint8Array(lh.buffer), name, f.data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true);
      ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      centrals.push(new Uint8Array(ch.buffer), name);

      offset += 30 + name.length + size;
    }

    const cdSize = centrals.reduce((n, a) => n + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);

    const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
    let p = 0;
    for (const a of parts) { out.set(a, p); p += a.length; }
    return out;
  }

  /* ---------------- xlsx 쓰기 ---------------- */

  function sheetXml(sheet) {
    const rows = sheet.rows || [];
    const cols = (sheet.widths || [])
      .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Number(w) || 12}" customWidth="1"/>`)
      .join("");

    const body = rows.map((row, r) => {
      const cells = (row || []).map((v, c) => {
        if (v === null || v === undefined || v === "") return "";
        const ref = colName(c) + (r + 1);
        const style = r === 0 && sheet.header !== false ? ' s="1"' : "";
        if (typeof v === "number" && isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
        return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
      }).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    }).join("");

    const freeze = sheet.header !== false && rows.length
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      freeze + (cols ? `<cols>${cols}</cols>` : "") + `<sheetData>${body}</sheetData></worksheet>`;
  }

  function write(sheets) {
    const n = sheets.length;
    const idx = [...Array(n).keys()];
    const xml = (s) => enc.encode(s);
    const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

    const files = [
      { name: "[Content_Types].xml", data: xml(head +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        idx.map((i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        '</Types>') },
      { name: "_rels/.rels", data: xml(head +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>') },
      { name: "xl/workbook.xml", data: xml(head +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<bookViews><workbookView activeTab="0"/></bookViews><sheets>' + idx.map((i) => `<sheet name="${escXml(sheets[i].name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + '</sheets>' +
        '</workbook>') },
      { name: "xl/_rels/workbook.xml.rels", data: xml(head +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        idx.map((i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>') },
      { name: "xl/styles.xml", data: xml(head +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts>' +
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>') },
      ...idx.map((i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml(sheetXml(sheets[i])) }))
    ];
    return zipStore(files);
  }

  /* ---------------- zip 읽기 ---------------- */

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);

    // 끝에서부터 중앙 디렉터리 종료 레코드를 찾는다
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("엑셀(.xlsx) 파일이 아니거나 손상된 파일입니다.");

    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = {};

    for (let k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("파일 구조를 읽을 수 없습니다.");
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));

      const lNameLen = dv.getUint16(local + 26, true);
      const lExtraLen = dv.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      const raw = u8.subarray(start, start + csize);

      out[name] = { method, raw };
      p += 46 + nameLen + extraLen + commLen;
    }

    return {
      has: (name) => name in out,
      async text(name) {
        const e = out[name];
        if (!e) return null;
        if (e.method === 0) return dec.decode(e.raw);
        if (e.method === 8) return dec.decode(await inflateRaw(e.raw));
        throw new Error("지원하지 않는 압축 방식입니다.");
      }
    };
  }

  /* ---------------- xlsx 읽기 ---------------- */

  const parseXml = (s) => new DOMParser().parseFromString(s, "application/xml");
  const byTag = (node, tag) => Array.from(node.getElementsByTagNameNS("*", tag));

  function attrLocal(el, local) {
    for (const a of el.attributes) if (a.localName === local) return a.value;
    return null;
  }

  /** 공유 문자열 한 항목의 글자. 윗주(rPh)는 제외한다 */
  function siText(si) {
    return byTag(si, "t")
      .filter((t) => !(t.parentNode && t.parentNode.localName === "rPh"))
      .map((t) => t.textContent)
      .join("");
  }

  function resolveTarget(target) {
    if (target.startsWith("/")) return target.slice(1);
    let t = "xl/" + target;
    while (/[^/]+\/\.\.\//.test(t)) t = t.replace(/[^/]+\/\.\.\//, "");
    return t;
  }

  async function read(buffer) {
    const zip = await unzip(buffer);

    const wbText = await zip.text("xl/workbook.xml");
    if (!wbText) throw new Error("엑셀 통합문서 정보를 찾을 수 없습니다.");
    const relsText = await zip.text("xl/_rels/workbook.xml.rels");

    const rels = {};
    if (relsText) {
      for (const r of byTag(parseXml(relsText), "Relationship")) {
        rels[r.getAttribute("Id")] = r.getAttribute("Target");
      }
    }

    const shared = [];
    const sst = await zip.text("xl/sharedStrings.xml");
    if (sst) for (const si of byTag(parseXml(sst), "si")) shared.push(siText(si));

    const book = {};
    const sheets = byTag(parseXml(wbText), "sheet");
    for (let i = 0; i < sheets.length; i++) {
      const s = sheets[i];
      const name = s.getAttribute("name") || `Sheet${i + 1}`;
      const rid = attrLocal(s, "id");
      const path = rid && rels[rid] ? resolveTarget(rels[rid]) : `xl/worksheets/sheet${i + 1}.xml`;
      const xmlText = await zip.text(path);
      if (!xmlText) { book[name] = []; continue; }

      const rows = [];
      for (const row of byTag(parseXml(xmlText), "row")) {
        const rIdx = (parseInt(row.getAttribute("r"), 10) || rows.length + 1) - 1;
        const cells = [];
        let auto = 0;
        for (const c of byTag(row, "c")) {
          const ref = c.getAttribute("r");
          const ci = ref ? colIndex(ref) : auto;
          auto = ci + 1;
          const type = c.getAttribute("t");
          const vEl = byTag(c, "v")[0];
          let val = "";
          if (type === "s") val = shared[parseInt(vEl && vEl.textContent, 10)] ?? "";
          else if (type === "inlineStr") val = byTag(c, "is").map(siText).join("");
          else if (type === "b") val = vEl && vEl.textContent === "1" ? "TRUE" : "FALSE";
          else val = vEl ? vEl.textContent : "";
          cells[ci] = val;
        }
        rows[rIdx] = Array.from(cells, (v) => (v === undefined ? "" : v));
      }
      book[name] = Array.from(rows, (r) => r || []);
    }
    return book;
  }

  return { write, read };
})();
