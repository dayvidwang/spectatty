export interface CastHeader {
  version: 2
  width: number
  height: number
  timestamp?: number
  title?: string
  env?: Record<string, string>
}

export interface CastEvent {
  time: number  // seconds since recording start
  type: string  // "o" = output, "i" = input, "r" = resize
  data: string
}

export interface Cast {
  header: CastHeader
  events: CastEvent[]
}

export function parseCast(content: string): Cast {
  const lines = content.split("\n")
  const nonEmpty = lines.filter((l) => l.trim())

  if (nonEmpty.length === 0) {
    throw new Error("Empty cast file")
  }

  let header: CastHeader
  try {
    header = JSON.parse(nonEmpty[0]) as CastHeader
  } catch {
    throw new Error("Invalid cast file: header is not valid JSON")
  }

  if (header.version !== 2) {
    throw new Error(`Unsupported cast version: ${JSON.stringify(header.version)} (expected 2)`)
  }
  if (typeof header.width !== "number" || typeof header.height !== "number") {
    throw new Error("Invalid cast header: missing width or height")
  }

  const events: CastEvent[] = []
  for (let i = 1; i < nonEmpty.length; i++) {
    const line = nonEmpty[i]
    try {
      const parsed = JSON.parse(line)
      if (Array.isArray(parsed) && parsed.length >= 3) {
        const [time, type, data] = parsed
        if (typeof time === "number" && typeof type === "string" && typeof data === "string") {
          events.push({ time, type, data })
        }
      }
    } catch {
      // skip malformed event lines
    }
  }

  return { header, events }
}

export async function parseCastFile(filePath: string): Promise<Cast> {
  const content = await Bun.file(filePath).text()
  return parseCast(content)
}
