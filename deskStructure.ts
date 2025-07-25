import {StructureBuilder} from 'sanity/desk'

export const deskStructure = (S: StructureBuilder) =>
  S.list()
    .title('Content')
    .items([
      S.listItem()
        .title('Home Page')
        .id('homePage')
        .child(S.document().schemaType('homePage').documentId('singleton-homePage')),

      // Divider
      S.divider(),

      // All other document types (auto-includes everything else)
      ...S.documentTypeListItems().filter((item) => item.getId() !== 'homePage'),
    ])
