export class ProjectNotFound extends Error {
  constructor(ref: string) {
    super(`Project not found: ${ref}`)
    this.name = 'ProjectNotFound'
  }
}
