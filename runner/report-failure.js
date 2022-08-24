import {
  reportTask,
} from './helpers.js'

async function main() {
  const messageWithoutFields = [
    {
      title: `CAS failed (${process.env.AWS_ECS_CLUSTER})`,
      color: 16711712, // Red
    },
  ]
  reportTask(messageWithoutFields)
}

main()
  .then(() => {
    console.log('Done')
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
