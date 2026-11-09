import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const EMPTY_COUNT = 0
const root = path.resolve(import.meta.dirname, '..')
const webOutput = path.join(root, 'dist', 'web')
const files = []

const collectFiles = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(absolute)
    } else if (entry.isFile()) {
      files.push(path.relative(webOutput, absolute).split(path.sep).join('/'))
    }
  }
}

await collectFiles(webOutput)

if (files.length === EMPTY_COUNT) {
  throw new Error('Production web output is empty')
}

const entryHtml = 'index.html'
const htmlFiles = files.filter((file) => file.endsWith('.html'))
if (!htmlFiles.includes(entryHtml)) {
  throw new Error('Production web output is missing index.html')
}

const unexpectedHtml = htmlFiles.filter((file) => file !== entryHtml)
const developmentArtifacts = files.filter((file) =>
  file.startsWith('apps/render-preview/')
  || file.startsWith('apps/shader-probe/')
  || /(?:^|\/)(?:renderPreview|shaderProbe)-/u.test(file)
)

if (unexpectedHtml.length > 0 || developmentArtifacts.length > 0) {
  const leakedEntries = [...new Set([...unexpectedHtml, ...developmentArtifacts])]
  throw new Error(`Development pages are present in production output: ${leakedEntries.join(', ')}`)
}

const entrySize = (await stat(path.join(webOutput, entryHtml))).size
if (entrySize === EMPTY_COUNT) {
  throw new Error('Production web entry is empty')
}

process.stdout.write(`verified ${files.length} production web files; development pages are absent\n`)
