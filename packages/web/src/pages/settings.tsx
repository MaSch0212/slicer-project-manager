import { SettingsGeneral } from './settings-general'
import { SettingsLayout } from './settings-layout'

export default function SettingsPage() {
  return (
    <SettingsLayout active="general" width="narrow">
      <SettingsGeneral />
    </SettingsLayout>
  )
}
