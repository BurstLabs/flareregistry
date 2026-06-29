import { LegalPage } from "@/components/legal-page";

// Ordered section ids; their text lives in i18n under privacy.s.<id>.*
const SECTIONS = [
  "scope",
  "collect",
  "onchain",
  "use",
  "logos",
  "cookies",
  "sharing",
  "retention",
  "rights",
  "security",
  "children",
  "changes",
  "contact",
];

export default function PrivacyPage() {
  return <LegalPage prefix="privacy" sections={SECTIONS} />;
}
