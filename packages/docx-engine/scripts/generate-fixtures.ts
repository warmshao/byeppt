import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDocx, buildKitchenSinkDocx } from '../tests/helpers/build-docx'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/generated')

async function main() {
  mkdirSync(outDir, { recursive: true })

  const kitchenSink = await buildKitchenSinkDocx()
  writeFileSync(join(outDir, 'kitchen-sink.docx'), kitchenSink)

  const simple = await buildDocx({
    bodyXml:
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>第一段。</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>第二段。</w:t></w:r></w:p>',
  })
  writeFileSync(join(outDir, 'simple.docx'), simple)

  console.log(`fixtures written to ${outDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
