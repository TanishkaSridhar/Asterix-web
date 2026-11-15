/* The team's official contact details. Pages show the values saved from the
   admin portal, falling back to these when a saved value is missing or is not
   a proper link, so a bad edit can never put a broken link on the site. */
export const OFFICIAL_CONTACT = {
    email: 'asterix@psgitech.ac.in',
    instagramUrl: 'https://www.instagram.com/asterix_itech?exln=OWZ3Z3UwbXI3czN4',
    linkedinUrl: 'https://www.linkedin.com/company/teamasterix/',
    githubUrl: 'https://github.com/Team-Asterix264016'
};

const SITE_HOSTS = {
    instagramUrl: 'instagram.com',
    linkedinUrl: 'linkedin.com',
    githubUrl: 'github.com'
};

/* A saved social link is used only if it is an https link to the right site. */
export function socialUrl(contact, field) {
    const value = String(contact?.[field] || '').trim();
    try {
        const url = new URL(value);
        const host = url.hostname.replace(/^www\./, '');
        if (url.protocol === 'https:' && (host === SITE_HOSTS[field] || host.endsWith(`.${SITE_HOSTS[field]}`))) {
            return value;
        }
    } catch {
        // not a URL: fall through to the official link
    }
    return OFFICIAL_CONTACT[field];
}

/* A saved email is used only if it looks like an email address. */
export function contactEmail(contact) {
    const value = String(contact?.email || '').trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : OFFICIAL_CONTACT.email;
}
