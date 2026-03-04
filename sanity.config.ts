import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {visionTool} from '@sanity/vision'
import {schemaTypes} from './schemaTypes'
import {deskStructure} from './deskStructure'

export default defineConfig({
  name: 'default',
  title: 'Foundation Collective',

  projectId: '4qydhzw9',
  dataset: 'production',

  plugins: [visionTool(), structureTool({structure: deskStructure})],

  schema: {
    types: schemaTypes,
  },
})
