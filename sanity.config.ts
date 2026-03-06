import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {visionTool} from '@sanity/vision'
import {ImagesIcon} from '@sanity/icons'
import {schemaTypes} from './schemaTypes'
import {deskStructure} from './deskStructure'
import {BulkUploadTool} from './tools/BulkUploadTool'

export default defineConfig({
  name: 'default',
  title: 'Foundation Collective',

  projectId: '4qydhzw9',
  dataset: 'production',

  plugins: [visionTool(), structureTool({structure: deskStructure})],

  schema: {
    types: schemaTypes,
  },

  document: {
    actions: (prev, context) => {
      if (context.schemaType === 'homePage') {
        return prev
      }
      return prev.map((action) => {
        if (action.action === 'delete') {
          const wrappedAction: typeof action = (props) => {
            const result = action(props)
            if (!result) return null
            return {...result, group: ['paneActions']}
          }
          wrappedAction.action = action.action
          wrappedAction.displayName = action.displayName
          return wrappedAction
        }
        return action
      })
    },
  },

  tools: [
    {
      name: 'bulk-upload',
      title: 'Bulk Upload',
      icon: ImagesIcon,
      component: BulkUploadTool,
    },
  ],
})
