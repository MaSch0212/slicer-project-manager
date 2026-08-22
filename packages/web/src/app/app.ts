import { Component } from '@angular/core'
import { RouterOutlet } from '@angular/router'

/** The shell: routing only. Tasks 18-22 fill in the pages behind the outlet. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class App {}
