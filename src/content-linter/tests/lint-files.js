import { fileURLToPath } from 'url'
import path from 'path'
import slash from 'slash'
import walk from 'walk-sync'
import { zip } from 'lodash-es'
import yaml from 'js-yaml'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { visit } from 'unist-util-visit'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { jest } from '@jest/globals'

import { frontmatter, deprecatedProperties } from '../../../lib/frontmatter.js'
import languages from '#src/languages/lib/languages.js'
import { liquid } from '#src/content-render/index.js'
import { getDiffFiles } from '../lib/diff-files.js'

jest.useFakeTimers({ legacyFakeTimers: true })

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const rootDir = path.join(__dirname, '../../..')
const contentDir = path.join(rootDir, 'content')
const reusablesDir = path.join(rootDir, 'data/reusables')
const variablesDir = path.join(rootDir, 'data/variables')
const glossariesDir = path.join(rootDir, 'data/glossaries')
const fbvDir = path.join(rootDir, 'data/features')

const languageCodes = Object.keys(languages)

// This is a string that contributors can use in markdown and yaml files as a placeholder.
// If any placeholders slip through, this test will flag them.
const placeholder = 'TODOCS'
const placeholderRegex = new RegExp(`\\b${placeholder}\\b`, 'gi')

// WARNING: Complicated RegExp below!
//
// Things matched by this RegExp:
//  - [link text](link-url)
//  - [link text] (link-url)
//  - [link-definition-ref]: link-url
//  - etc.
//
// Things intentionally NOT matched by this RegExp:
//  - [link text](#link-url)
//  - [link text] (#link-url)
//  - [link-definition-ref]: #link-url
//  - [link text](/link-url)
//  - [link-definition-ref]: /link-url
//  - [link text](https://link-url)
//  - [link-definition-ref]: https://link-url
//  - [link text](mailto:mail-url)
//  - [link-definition-ref]: mailto:mail-url
//  - [link text](tel:phone-url)
//  - [link-definition-ref]: tel:phone-url
//  - [link text]({{ site.data.variables.product_url }})
//  - [link-definition-ref]: {{ site.data.variables.product_url }}
//  - [link text][link-definition-ref]: other text
//  - [link text][link-definition-ref] (other text)
//  - etc.
//
const relativeArticleLinkRegex =
  /(?=^|[^\]]\s*)\[[^\]]+\](?::\n?[ \t]+|\s*\()(?!\/|#|https?:\/\/|tel:|mailto:|\{[%{]\s*)[^)\s]+(?:(?:\s*[%}]\})?\)|\s+|$)/gm

// Things matched by this RegExp:
//  - [link text](/en/github/blah)
//  - [link text] (https://docs.github.com/ja/github/blah)
//  - [link-definition-ref]: http://help.github.com/es/github/blah
//  - etc.
//
// Things intentionally NOT matched by this RegExp:
//  - [Node.js](https://nodejs.org/en/)
//  - etc.
//
const languageLinkRegex = new RegExp(
  `(?=^|[^\\]]\\s*)\\[[^\\]]+\\](?::\\n?[ \\t]+|\\s*\\()(?:(?:https?://(?:help|docs|developer)\\.github\\.com)?/(?:${languageCodes.join(
    '|',
  )})(?:/[^)\\s]*)?)(?:\\)|\\s+|$)`,
  'gm',
)

// Things matched by this RegExp:
//  - [link text](/enterprise/2.19/admin/blah)
//  - [link text] (https://docs.github.com/enterprise/11.10.340/admin/blah)
//  - [link-definition-ref]: http://help.github.com/enterprise/2.8/admin/blah
//
// Things intentionally NOT matched by this RegExp:
//  - [link text](https://someservice.com/enterprise/1.0/blah)
//  - [link text](/github/site-policy/enterprise/2.2/admin/blah)
const versionLinkRegEx =
  /(?=^|[^\]]\s*)\[[^\]]+\](?::\n?[ \t]+|\s*\()(?:(?:https?:\/\/(?:help|docs|developer)\.github\.com)?\/enterprise\/\d+(\.\d+)+(?:\/[^)\s]*)?)(?:\)|\s+|$)/gm

// Things matched by this RegExp:
//  - [link text](/early-access/github/blah)
//  - [link text] (https://docs.github.com/early-access/github/blah)
//  - [link-definition-ref]: http://help.github.com/early-access/github/blah
//  - etc.
//
// Things intentionally NOT matched by this RegExp:
//  - [Node.js](https://nodejs.org/early-access/)
//  - etc.
//
const earlyAccessLinkRegex =
  /(?=^|[^\]]\s*)\[[^\]]+\](?::\n?[ \t]+|\s*\()(?:(?:https?:\/\/(?:help|docs|developer)\.github\.com)?\/early-access(?:\/[^)\s]*)?)(?:\)|\s+|$)/gm

//  - [link text](https://docs.github.com/github/blah)
//  - [link text] (https://help.github.com/github/blah)
//  - [link-definition-ref]: http://developer.github.com/v3/
//  - [link text](//docs.github.com)
//  - etc.
//
// Things intentionally NOT matched by this RegExp:
//  - [link text](/github/blah)
//  - [link text[(https://developer.github.com/changes/2018-02-22-protected-branches-required-signatures/)
//  - etc.
//
const domainLinkRegex =
  /(?=^|[^\]]\s*)\[[^\]]+\](?::\n?[ \t]+|\s*\()(?:https?:)?\/\/(?:help|docs|developer)\.github\.com(?!\/changes\/)[^)\s]*(?:\)|\s+|$)/gm

// Things matched by this RegExp:
//  - ![image text](/assets/images/early-access/github/blah.gif)
//  - ![image text] (https://docs.github.com/assets/images/early-access/github/blah.gif)
//  - [image-definition-ref]: http://help.github.com/assets/images/early-access/github/blah.gif
//  - [link text](/assets/images/early-access/github/blah.gif)
//  - etc.
//
// Things intentionally NOT matched by this RegExp:
//  - [Node.js](https://nodejs.org/assets/images/early-access/blah.gif)
//  - etc.
//
const earlyAccessImageRegex =
  /(?=^|[^\]]\s*)\[[^\]]+\](?::\n?[ \t]+|\s*\()(?:(?:https?:\/\/(?:help|docs|developer)\.github\.com)?\/assets\/images\/early-access(?:\/[^)\s]*)?)(?:\)|\s+|$)/gm

// Things matched by this RegExp:
//  - ![image text](/assets/early-access/images/github/blah.gif)
//  - ![image text] (https://docs.github.com/images/early-access/github/blah.gif)
//  - [image-definition-ref]: http://help.github.com/assets/early-access/github/blah.gif
//  - [link text](/early-access/assets/images/github/blah.gif)
//  - [link text](/early-access/images/github/blah.gif)
//  - etc.
//
// Things intentionally NOT matched by this RegExp:
//  - [Node.js](https://nodejs.org/assets/early-access/images/blah.gif)
//  - etc.
//
const badEarlyAccessImageRegex =
  /(?=^|[^\]]\s*)\[[^\]]+\](?::\n?[ \t]+|\s*\()(?:(?:https?:\/\/(?:help|docs|developer)\.github\.com)?\/(?:(?:assets|images)\/early-access|early-access\/(?:assets|images))(?:\/[^)\s]*)?)(?:\)|\s+|$)/gm

// {{ site.data.example.pizza }}
const oldVariableRegex = /{{\s*?site\.data\..*?}}/g

//  - {{ octicon-plus }}
//  - {{ octicon-plus An example label }}
//
const oldOcticonRegex = /{{\s*?octicon-([a-z-]+)(\s[\w\s\d-]+)?\s*?}}/g
const relativeArticleLinkErrorText = 'Found unexpected relative article links:'
const languageLinkErrorText = 'Found article links with hard-coded language codes:'
const versionLinkErrorText = 'Found article links with hard-coded version numbers:'
const domainLinkErrorText = 'Found article links with hard-coded domain names:'
const earlyAccessLinkErrorText = 'Found article links leaking Early Access docs:'
const earlyAccessImageErrorText = 'Found article images/links leaking Early Access images:'
const badEarlyAccessImageErrorText =
  'Found article images/links leaking incorrect Early Access images:'
const oldVariableErrorText =
  'Found article uses old {{ site.data... }} syntax. Use {% data example.data.string %} instead!'
const oldOcticonErrorText =
  'Found octicon variables with the old {{ octicon-name }} syntax. Use {% octicon "name" %} instead!'

const mdWalkOptions = {
  globs: ['**/*.md'],
  ignore: ['**/README.md'],
  directories: false,
  includeBasePath: true,
}

// Also test the "data/variables/" YAML files

const yamlWalkOptions = {
  globs: ['**/*.yml'],
  directories: false,
  includeBasePath: true,
}

// different lint rules apply to different content types
let mdToLint, ymlToLint

// compile lists of all the files we want to lint

const contentMarkdownAbsPaths = walk(contentDir, mdWalkOptions).sort()
const contentMarkdownRelPaths = contentMarkdownAbsPaths.map((p) => slash(path.relative(rootDir, p)))

// Get the list of config files for automated pipelines
const automatedConfigFiles = walk(`src`, { includeBasePath: true, globs: ['**/lib/config.json'] })
// Get a list of Markdown files to ignore during Markdown linting
const automatedIgnorePaths = (
  await Promise.all(
    automatedConfigFiles.map(async (p) => {
      return JSON.parse(await fs.readFile(p, 'utf8')).linterIgnore || []
    }),
  )
)
  .flat()
  .filter(Boolean)

// For each linterIgnore directory, walk the files in the directory and add
// to the ignore list.
const ignoreMarkdownFilesAbsPath = new Set(
  automatedIgnorePaths
    .filter((p) => {
      const exists = existsSync(p)
      if (!exists) {
        console.warn(
          `WARNING: Ignored path ${p} defined in an automation pipeline does not exist. This may be expected, but if not, remove the defined path from the pipeline config.`,
        )
      }
      return exists
    })
    .map((p) =>
      walk(p, {
        includeBasePath: true,
        globs: ['**/*.md'],
      }),
    )
    .flat(),
)

// Difference between contentMarkdownAbsPaths & automatedIgnorePaths
const contentMarkdownNoAutomated = [...contentMarkdownRelPaths].filter(
  (p) => !ignoreMarkdownFilesAbsPath.has(p),
)
// We also need to go back and get the difference between the
// absolute paths list
const contentMarkdownAbsPathNoAutomated = [...contentMarkdownAbsPaths].filter(
  (p) => !ignoreMarkdownFilesAbsPath.has(slash(path.relative(rootDir, p))),
)

const contentMarkdownTuples = zip(contentMarkdownNoAutomated, contentMarkdownAbsPathNoAutomated)

const reusableMarkdownAbsPaths = walk(reusablesDir, mdWalkOptions).sort()
const reusableMarkdownRelPaths = reusableMarkdownAbsPaths.map((p) =>
  slash(path.relative(rootDir, p)),
)
const reusableMarkdownTuples = zip(reusableMarkdownRelPaths, reusableMarkdownAbsPaths)

mdToLint = [...contentMarkdownTuples, ...reusableMarkdownTuples]

// data/variables
const variableYamlAbsPaths = walk(variablesDir, yamlWalkOptions).sort()
const variableYamlRelPaths = variableYamlAbsPaths.map((p) => slash(path.relative(rootDir, p)))
const variableYamlTuples = zip(variableYamlRelPaths, variableYamlAbsPaths)

// data/glossaries
const glossariesYamlAbsPaths = walk(glossariesDir, yamlWalkOptions).sort()
const glossariesYamlRelPaths = glossariesYamlAbsPaths.map((p) => slash(path.relative(rootDir, p)))
const glossariesYamlTuples = zip(glossariesYamlRelPaths, glossariesYamlAbsPaths)

// data/features (feature-based versioning)
const FbvYamlAbsPaths = walk(fbvDir, yamlWalkOptions).sort()
const FbvYamlRelPaths = FbvYamlAbsPaths.map((p) => slash(path.relative(rootDir, p)))
const fbvTuples = zip(FbvYamlRelPaths, FbvYamlAbsPaths)

// Put all the yaml files together
ymlToLint = [].concat(
  variableYamlTuples, // These "tuples" not tested independently; they are only tested as part of ymlToLint.
  glossariesYamlTuples,
  fbvTuples,
)

function formatLinkError(message, links) {
  return `${message}\n  - ${links.join('\n  - ')}`
}

// Returns `content` if its a string, or `content.description` if it can.
// Used for getting the nested `description` key in glossary files.
function getContent(content) {
  if (typeof content === 'string') return content
  if (typeof content.description === 'string') return content.description
  return null
}

const diffFiles = getDiffFiles()

// If present, and not empty, leverage it because in most cases it's empty.
if (diffFiles.length > 0) {
  // It's faster to do this once and then re-use over and over in the
  // .filter() later on.
  const only = new Set(
    // If the environment variable encodes all the names
    // with quotation marks, strip them.
    // E.g. Turn `"foo" "bar"` into ['foo', 'bar']
    // Note, this assumes no possible file contains a space.
    diffFiles.map((name) => {
      if (/^['"]/.test(name) && /['"]$/.test(name)) {
        return name.slice(1, -1)
      }
      return name
    }),
  )
  const filterFiles = (tuples) =>
    tuples.filter(
      ([relativePath, absolutePath]) => only.has(relativePath) || only.has(absolutePath),
    )
  mdToLint = filterFiles(mdToLint)
  ymlToLint = filterFiles(ymlToLint)
}

if (mdToLint.length + ymlToLint.length < 1) {
  // With this in place, at least one `test()` is called and you don't
  // get the `Your test suite must contain at least one test.` error
  // from `jest`.
  describe('deliberately do nothing', () => {
    test('void', () => {})
  })
}

describe('lint markdown content', () => {
  if (mdToLint.length < 1) return

  describe.each(mdToLint)('%s', (markdownRelPath, markdownAbsPath) => {
    let content,
      ast,
      links,
      isHidden,
      isEarlyAccess,
      isSitePolicy,
      isSearch,
      isTranscript,
      isTranscriptLanding,
      hasExperimentalAlternative,
      frontmatterData

    beforeAll(async () => {
      const fileContents = await fs.readFile(markdownAbsPath, 'utf8')
      const { data, content: bodyContent } = frontmatter(fileContents)

      content = bodyContent
      frontmatterData = data
      ast = fromMarkdown(content)
      isHidden = data.hidden === true
      const split = markdownRelPath.split('/')
      isEarlyAccess = split.includes('early-access')
      isSitePolicy = split.includes('site-policy-deprecated')
      isSearch = split.includes('search') && !split.includes('reusables')
      isTranscript = split.includes('video-transcripts')
      isTranscriptLanding = isTranscript && split.includes('index.md')
      hasExperimentalAlternative = data.hasExperimentalAlternative === true

      links = []
      visit(ast, ['link', 'definition'], (node) => {
        links.push(node.url)
      })
    })

    test('hidden docs must be Early Access, Site Policy, Search, Experimental, or Transcript', async () => {
      // We need to support some non-Early Access hidden docs in Site Policy
      if (isHidden) {
        expect(
          isEarlyAccess || isSitePolicy || isSearch || hasExperimentalAlternative || isTranscript,
        ).toBe(true)
      }
    })

    // see contributing/videos.md
    test('transcripts must contain intro link to video being transcribed', async () => {
      if (isTranscript && !isTranscriptLanding) {
        expect(frontmatterData.product_video).toBeDefined()
      }
    })

    // see contributing/videos.md
    test('transcripts must be prepended with "Transcript - "', async () => {
      if (isTranscript && !isTranscriptLanding) {
        expect(frontmatterData.title.startsWith('Transcript - ')).toBe(true)
      }
    })

    // see contributing/videos.md
    test('videos on product landing pages must contain transcript', async () => {
      if (frontmatterData.layout === 'product-landing' && frontmatterData.product_video) {
        expect(frontmatterData.product_video_transcript).toMatch(/^\/video-transcripts\/.+/)
      }
    })

    test('contains no deprecated frontmatter properties', async () => {
      if (!isEarlyAccess) {
        const usedDeprecateProps = deprecatedProperties.filter((prop) => {
          return Object.keys(frontmatterData).includes(prop)
        })
        expect(
          usedDeprecateProps,
          `The following frontmatter properties are deprecated: ${usedDeprecateProps}. Please remove the property from your article's frontmatter.`,
        ).toEqual([])
      }
    })

    test('contains valid Liquid', async () => {
      // If Liquid can't parse the file, it'll throw an error.
      // For example, the following is invalid and will fail this test:
      // {% if currentVersion ! "github-ae@latest" %}
      expect(() => liquid.parse(content)).not.toThrow()
    })

    if (!markdownRelPath.includes('data/reusables')) {
      test('frontmatter contains valid liquid', async () => {
        const fmKeysWithLiquid = ['title', 'shortTitle', 'intro', 'product', 'permission'].filter(
          (key) => Boolean(frontmatterData[key]),
        )

        for (const key of fmKeysWithLiquid) {
          expect(() => liquid.parse(frontmatterData[key])).not.toThrow()
        }
      })
    }
  })
})

describe('lint yaml content', () => {
  if (ymlToLint.length < 1) return
  describe.each(ymlToLint)('%s', (yamlRelPath, yamlAbsPath) => {
    let dictionary, isEarlyAccess, fileContents
    // This variable is used to determine if the file was parsed successfully.
    // When `yaml.load()` fails to parse the file, it is overwritten with the error message.
    // `false` is intentionally chosen since `null` and `undefined` are valid return values.
    let dictionaryError = false

    beforeAll(async () => {
      fileContents = await fs.readFile(yamlAbsPath, 'utf8')
      try {
        dictionary = yaml.load(fileContents, { filename: yamlRelPath })
      } catch (error) {
        dictionaryError = error
      }

      isEarlyAccess = yamlRelPath.split('/').includes('early-access')
    })

    test('it can be parsed as a single yaml document', () => {
      expect(dictionaryError).toBe(false)
    })

    test('placeholder string is not present in any yaml files', () => {
      const matches = fileContents.match(placeholderRegex) || []
      const errorMessage = `
        Found ${matches.length} placeholder string '${placeholder}'! Please update all placeholders.
      `
      expect(matches.length, errorMessage).toBe(0)
    })

    test('relative URLs must start with "/"', async () => {
      const matches = []

      for (const [key, content] of Object.entries(dictionary)) {
        const contentStr = getContent(content)
        if (!contentStr) continue
        const valMatches = contentStr.match(relativeArticleLinkRegex) || []
        if (valMatches.length > 0) {
          matches.push(...valMatches.map((match) => `Key "${key}": ${match}`))
        }
      }

      const errorMessage = formatLinkError(relativeArticleLinkErrorText, matches)
      expect(matches.length, errorMessage).toBe(0)
    })

    test('must not leak Early Access doc URLs', async () => {
      // Only execute for docs that are NOT Early Access
      if (!isEarlyAccess) {
        const matches = []

        for (const [key, content] of Object.entries(dictionary)) {
          const contentStr = getContent(content)
          if (!contentStr) continue
          const valMatches = contentStr.match(earlyAccessLinkRegex) || []
          if (valMatches.length > 0) {
            matches.push(...valMatches.map((match) => `Key "${key}": ${match}`))
          }
        }

        const errorMessage = formatLinkError(earlyAccessLinkErrorText, matches)
        expect(matches.length, errorMessage).toBe(0)
      }
    })

    test('must not leak Early Access image URLs', async () => {
      // Only execute for docs that are NOT Early Access
      if (!isEarlyAccess) {
        const matches = []

        for (const [key, content] of Object.entries(dictionary)) {
          const contentStr = getContent(content)
          if (!contentStr) continue
          const valMatches = contentStr.match(earlyAccessImageRegex) || []
          if (valMatches.length > 0) {
            matches.push(...valMatches.map((match) => `Key "${key}": ${match}`))
          }
        }

        const errorMessage = formatLinkError(earlyAccessImageErrorText, matches)
        expect(matches.length, errorMessage).toBe(0)
      }
    })

    test('must have correctly formatted Early Access image URLs', async () => {
      // Execute for ALL docs (not just Early Access) to ensure non-EA docs
      // are not leaking incorrectly formatted EA image URLs
      const matches = []

      for (const [key, content] of Object.entries(dictionary)) {
        const contentStr = getContent(content)
        if (!contentStr) continue
        const valMatches = contentStr.match(badEarlyAccessImageRegex) || []
        if (valMatches.length > 0) {
          matches.push(...valMatches.map((match) => `Key "${key}": ${match}`))
        }
      }

      const errorMessage = formatLinkError(badEarlyAccessImageErrorText, matches)
      expect(matches.length, errorMessage).toBe(0)
    })

    test('URLs must not contain a hard-coded language code', async () => {
      const matches = []

      for (const [key, content] of Object.entries(dictionary)) {
        const contentStr = getContent(content)
        if (!contentStr) continue
        const valMatches = contentStr.match(languageLinkRegex) || []
        if (valMatches.length > 0) {
          matches.push(...valMatches.map((match) => `Key "${key}": ${match}`))
        }
      }

      const errorMessage = formatLinkError(languageLinkErrorText, matches)
      expect(matches.length, errorMessage).toBe(0)
    })

    test('URLs must not contain a hard-coded version number', async () => {
      const matches = []

      for (const [key, content] of Object.entries(dictionary)) {
        const contentStr = getContent(content)
        if (!contentStr) continue
        const valMatches = contentStr.match(versionLinkRegEx) || []
        if (valMatches.length > 0) {
          matches.push(...valMatches.map((match) => `Key "${key}": ${match}`))
        }
      }

      const errorMessage = formatLinkError(versionLinkErrorText, matches)
      expect(matches.length, errorMessage).toBe(0)
    })

    test('URLs must not contain a hard-coded domain name', async () => {
      const matches = []

      for (const [key, content] of Object.entries(dictionary)) {
        const contentStr = getContent(content)
        if (!contentStr) continue
        const valMatches = contentStr.match(domainLinkRegex) || []
        if (valMatches.length > 0) {
          matches.push(...valMatches.map((match) => `Key "${key}": ${match}`))
        }
      }

      const errorMessage = formatLinkError(domainLinkErrorText, matches)
      expect(matches.length, errorMessage).toBe(0)
    })

    test('does not use old site.data variable syntax', async () => {
      const matches = []

      for (const [key, content] of Object.entries(dictionary)) {
        const contentStr = getContent(content)
        if (!contentStr) continue
        const valMatches = contentStr.match(oldVariableRegex) || []
        if (valMatches.length > 0) {
          matches.push(
            ...valMatches.map((match) => {
              const example = match.replace(
                /{{\s*?site\.data\.([a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]+)+)\s*?}}/g,
                '{% data $1 %}',
              )
              return `Key "${key}": ${match} => ${example}`
            }),
          )
        }
      }

      const errorMessage = formatLinkError(oldVariableErrorText, matches)
      expect(matches.length, errorMessage).toBe(0)
    })

    test('does not use old octicon variable syntax', async () => {
      const matches = []

      for (const [key, content] of Object.entries(dictionary)) {
        const contentStr = getContent(content)
        if (!contentStr) continue
        const valMatches = contentStr.match(oldOcticonRegex) || []
        if (valMatches.length > 0) {
          matches.push(...valMatches.map((match) => `Key "${key}": ${match}`))
        }
      }

      const errorMessage = formatLinkError(oldOcticonErrorText, matches)
      expect(matches.length, errorMessage).toBe(0)
    })
  })
})
