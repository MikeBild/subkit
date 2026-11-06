import yauzl from "yauzl";
import {
  BinaryParseError,
  DetectionPriority,
  type FileParsingStrategy,
  PARSER_TIMEOUT_MS,
  withParserTimeout,
} from "./strategy.ts";
import { hasZipEntryPrefix } from "./zip-sniff.ts";

const SLIDE_PATH_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const TEXT_RUN_RE = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
const XML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

const PPTX_SLIDE_CAP = 2_000;

const PPTX_SLIDE_XML_MAX_BYTES = 2 * 1024 * 1024;

export interface PptxSlide {
  index: number;
  text: string;
}

export interface PptxParseOutput {
  format: "pptx";
  slides: PptxSlide[];
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITY_MAP[m] ?? m)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function extractSlideText(xml: string): string {
  const runs: string[] = [];
  for (let m = TEXT_RUN_RE.exec(xml); m !== null; m = TEXT_RUN_RE.exec(xml)) {
    runs.push(decodeXmlEntities(m[1] ?? ""));
  }
  return runs.join(" ").replace(/\s+/g, " ").trim();
}

export const pptxStrategy: FileParsingStrategy<PptxParseOutput> = {
  format: "pptx",
  priority: DetectionPriority.ZIP_BASED_SPECIFIC,

  canHandle(buffer: Buffer): boolean {
    return hasZipEntryPrefix(buffer, "ppt/");
  },

  async parse(buffer: Buffer): Promise<PptxParseOutput> {
    return withParserTimeout("pptx", PARSER_TIMEOUT_MS.pptx, async () => {
      try {
        const slides = await readSlides(buffer);
        slides.sort((a, b) => a.index - b.index);
        return { format: "pptx", slides };
      } catch (err) {
        if (err instanceof BinaryParseError) throw err;
        throw new BinaryParseError("pptx", "pptx: failed to read slides", { cause: err });
      }
    });
  },
};

function readSlides(buffer: Buffer): Promise<PptxSlide[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("pptx: zip open returned no handle"));
        return;
      }
      const slides: PptxSlide[] = [];
      zipfile.on("error", reject);
      zipfile.on("end", () => resolve(slides));
      zipfile.on("entry", (entry: yauzl.Entry) => {
        const match = SLIDE_PATH_RE.exec(entry.fileName);
        if (!match) {
          zipfile.readEntry();
          return;
        }
        if (slides.length >= PPTX_SLIDE_CAP) {
          reject(new BinaryParseError("pptx", `pptx: slide count exceeds ${PPTX_SLIDE_CAP} cap`));
          return;
        }
        const index = Number.parseInt(match[1] ?? "0", 10);
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            zipfile.readEntry();
            return;
          }
          const chunks: Buffer[] = [];
          let slideBytes = 0;
          let overflowed = false;
          stream.on("data", (chunk: Buffer) => {
            if (overflowed) return;
            slideBytes += chunk.byteLength;
            if (slideBytes > PPTX_SLIDE_XML_MAX_BYTES) {
              overflowed = true;
              stream.destroy();
              reject(
                new BinaryParseError(
                  "pptx",
                  `pptx: slide ${index} XML exceeds ${PPTX_SLIDE_XML_MAX_BYTES}-byte cap`,
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          stream.on("end", () => {
            if (overflowed) return;
            const xml = Buffer.concat(chunks).toString("utf8");
            slides.push({ index, text: extractSlideText(xml) });
            zipfile.readEntry();
          });
          stream.on("error", () => {
            if (!overflowed) zipfile.readEntry();
          });
        });
      });
      zipfile.readEntry();
    });
  });
}
