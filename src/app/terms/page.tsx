import { LegalPage } from "@/components/legal-page";

// Ordered section ids; their text lives in i18n under terms.s.<id>.*
const SECTIONS = [
  "acceptance",
  "service",
  "eligibility",
  "wallet",
  "accuracy",
  "governance",
  "conduct",
  "ip",
  "noWarranty",
  "liability",
  "changes",
  "contact",
];

export default function TermsPage() {
  return <LegalPage prefix="terms" sections={SECTIONS} />;
}
