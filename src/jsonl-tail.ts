import { open, stat } from "node:fs/promises";

export class JsonlTail {
  readonly path: string;
  private offset: number;
  private partial = "";

  constructor(path: string, offset = 0) {
    this.path = path;
    this.offset = offset;
  }

  static async atEnd(path: string): Promise<JsonlTail> {
    return new JsonlTail(path, await fileSize(path));
  }

  async readNew(): Promise<unknown[]> {
    const size = await fileSize(this.path);
    if (size < this.offset) {
      this.offset = 0;
      this.partial = "";
    }
    if (size === this.offset) return [];
    const handle = await open(this.path, "r");
    try {
      const length = size - this.offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, this.offset);
      this.offset = size;
      const text = this.partial + buffer.toString("utf8");
      const lines = text.split("\n");
      this.partial = lines.pop() ?? "";
      return lines.flatMap((line) => {
        if (!line.trim()) return [];
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
    } finally {
      await handle.close();
    }
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}
