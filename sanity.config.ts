import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {visionTool} from '@sanity/vision'
import {ImagesIcon, HeartIcon} from '@sanity/icons'
import {schemaTypes} from './schemaTypes'
import {deskStructure} from './deskStructure'
import {BulkUploadTool} from './tools/BulkUploadTool'
import {DataHealthTool} from './tools/DataHealthTool'

export default defineConfig({
  name: 'default',
  title: 'Foundation Collective',

  projectId: '4qydhzw9',
  dataset: 'production',

  plugins: [visionTool(), structureTool({structure: deskStructure})],

  schema: {
    types: schemaTypes,
  },

  tools: [
    {
      name: 'bulk-upload',
      title: 'Bulk Upload',
      icon: ImagesIcon,
      component: BulkUploadTool,
    },
    {
      name: 'data-health',
      title: 'Data Health',
      icon: HeartIcon,
      component: DataHealthTool,
    },
  ],
})
