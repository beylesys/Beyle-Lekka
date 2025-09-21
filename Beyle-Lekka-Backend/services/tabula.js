// services/tabula.js
// Robust Tabula wrapper: returns [{ page, rows: string[][] }, ...]
// Works with "java -jar tabula.jar -f JSON <pdf>"

import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const DEFAULT_JAR = path.resolve("scripts/vendor/tabula-1.0.5-jar-with-dependencies.jar");
const JAR = process.env.TABULA_JAR || DEFAULT_JAR;

/**
 * Extract tables from a PDF using Tabula.
 * @param {string} pdfPath absolute path to the PDF on disk
 * @param {string} pages   "all" (default) or e.g. "1-3,5"
 * @returns {Promise<{ok:boolean, tables:Array<{page:number|null, rows:string[][]}>, meta?:object, error?:string}>}
 */
export function extractTablesWithTabula(pdfPath, pages = "all") {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(pdfPath)) {
        return resolve({ ok: false, error: `PDF not found: ${pdfPath}`, tables: [] });
      }
      if (!fs.existsSync(JAR)) {
        return resolve({ ok: false, error: `TABULA_JAR not found at ${JAR}`, tables: [] });
      }

      const args = ["-Djava.awt.headless=true", "-jar", JAR, "-p", pages, "-f", "JSON", pdfPath];
      const child = spawn("java", args, { stdio: ["ignore", "pipe", "pipe"] });

      let out = "", err = "";
      child.stdout.on("data", d => (out += d.toString("utf8")));
      child.stderr.on("data", d => (err += d.toString("utf8")));
      child.on("close", (code) => {
        if (code !== 0) {
          return resolve({ ok: false, error: err || `Tabula exit ${code}`, tables: [] });
        }
        try {
          // Tabula JSON format: array of table objects
          // [{ extraction_method, page, data: [ [ {text: "..."} , ... ], ... ] }, ...]
          const arr = JSON.parse(out);
          if (!Array.isArray(arr)) {
            return resolve({ ok: true, tables: [], meta: { rawType: typeof arr } });
          }

          const tables = arr.map(tbl => {
            const rows = Array.isArray(tbl?.data)
              ? tbl.data.map(row =>
                  Array.isArray(row)
                    ? row.map(cell => (cell?.text ?? "").toString().trim())
                    : []
                )
              : [];
            return { page: tbl?.page ?? null, rows };
          });

          resolve({ ok: true, tables, meta: { count: tables.length } });
        } catch (e) {
          resolve({ ok: false, error: `Tabula JSON parse failed: ${e.message}`, tables: [] });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: e.message || "Tabula failed", tables: [] });
    }
  });
}
