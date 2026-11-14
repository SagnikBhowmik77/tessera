import { useState } from 'react';

// Interface text for the public pages (report, tracking, roadmap) in a few languages (E11).
// Only the page's own words are translated: what people write, and messages from the server,
// stay as they were written (translating them would need a paid service).
const en = {
  'common.poweredBy': 'Powered by Tessera', 'common.language': 'Language',
  'portal.unavailable': "This report page isn't available",
  'portal.unavailableHint': 'The link may be wrong, or the team has turned this page off or replaced the link.',
  'portal.title': 'Report a problem in {name}', 'portal.bug': 'Something is broken', 'portal.idea': 'I have an idea', 'portal.bugHint': 'An error, a crash, or something that does not work', 'portal.ideaHint': 'Something you would like it to do',
  'portal.what': 'What happened?', 'portal.whatPlaceholder': 'The pay button does nothing',
  'portal.details': 'Details', 'portal.detailsHint': 'What did you do, what did you expect, and what happened instead?',
  'portal.pasteError': 'Paste an error message (optional)', 'portal.errorPlaceholder': 'Copy it from the screen or the browser console', 'portal.errorLabel': 'Error message',
  'portal.name': 'Your name (optional)', 'portal.email': 'Email (optional)', 'portal.emailHint': "To tell you when it's fixed.",
  'portal.send': 'Send report', 'portal.thanks': 'Thanks, the {name} team has your report', 'portal.reference': 'Your reference is',
  'portal.known': 'This problem was already known, and your report has been added to it.', 'portal.willEmail': 'We will email you when it is fixed.',
  'portal.follow': 'Follow your report', 'portal.followHint': 'Keep this private link to see progress and talk to the team.', 'portal.another': 'Report something else',
  'portal.stepOf': "Step {n} of 3", 'portal.step1': "What happened", 'portal.step2': "The details", 'portal.step3': "How to reach you", 'portal.next': "Next", 'portal.back': "Back", 'portal.titleNeeded': "Give it a short title first, for example \"The pay button does nothing\".", 'portal.reachHint': "Both are optional. Leave an email and we will tell you when it is fixed.", 'portal.privacyTitle': "What the team sees", 'portal.privacy': "Only what you write here, and your name and email if you add them. If you paste an error, your browser and its version are kept with it to help reproduce the problem. Your IP address is used only to stop spam and is not saved with your report.",
  'track.unavailable': "This tracking link isn't available", 'track.unavailableHint': 'The link may be wrong, or the report was removed.',
  'track.yourReport': 'Your report to {name}', 'track.reported': 'Sent on {date}',
  'track.received': 'Received', 'track.accepted': 'Accepted', 'track.in_progress': 'Being worked on', 'track.fixed': 'Fixed', 'track.closed': 'Closed',
  'track.merged': 'The team found another report of the same problem; both are now handled together.',
  'track.live': 'Released in version {release}', 'track.waiting': 'Fixed, and will be live with the next release.',
  'track.question': 'Is it fixed for you?', 'track.yesFixed': "Yes, it's fixed", 'track.stillBroken': 'No, still broken',
  'track.thanksFixed': 'Thanks for confirming!', 'track.thanksBroken': 'Thanks for telling us. The team has reopened it.',
  'track.fromEmail': 'You opened this from the email. Please confirm here:',
  'track.conversation': 'Conversation with the team', 'track.none': 'No messages yet.', 'track.you': 'You', 'track.team': 'Team',
  'track.write': 'Add details or ask a question', 'track.send': 'Send',
  'roadmap.unavailable': "This roadmap isn't available", 'roadmap.unavailableHint': 'The link may be wrong, or the team has turned this page off.',
  'roadmap.title': '{name} roadmap', 'roadmap.planned': 'Planned', 'roadmap.in_progress': 'In progress', 'roadmap.done': 'Done',
  'roadmap.vote': 'Vote', 'roadmap.voted': 'Voted', 'roadmap.votes': 'Votes: {n}', 'roadmap.empty': 'Nothing here yet.',
  'roadmap.how': 'One vote per item from this browser. Click again to take it back.',
};

const es = {
  'common.poweredBy': 'Con la tecnología de Tessera', 'common.language': 'Idioma',
  'portal.unavailable': 'Esta página de reportes no está disponible',
  'portal.unavailableHint': 'Puede que el enlace sea incorrecto o que el equipo haya desactivado o cambiado esta página.',
  'portal.title': 'Informa de un problema en {name}', 'portal.bug': 'Algo no funciona', 'portal.idea': 'Tengo una idea', 'portal.bugHint': 'Un error o algo que no funciona como debería', 'portal.ideaHint': 'Algo que te gustaría que hiciera',
  'portal.what': '¿Qué pasó?', 'portal.whatPlaceholder': 'El botón de pago no hace nada',
  'portal.details': 'Detalles', 'portal.detailsHint': '¿Qué hiciste, qué esperabas y qué pasó en su lugar?',
  'portal.pasteError': 'Pega un mensaje de error (opcional)', 'portal.errorPlaceholder': 'Cópialo de la pantalla o de la consola del navegador', 'portal.errorLabel': 'Mensaje de error',
  'portal.name': 'Tu nombre (opcional)', 'portal.email': 'Correo electrónico (opcional)', 'portal.emailHint': 'Para avisarte cuando esté resuelto.',
  'portal.send': 'Enviar reporte', 'portal.thanks': 'Gracias, el equipo de {name} ha recibido tu reporte', 'portal.reference': 'Tu referencia es',
  'portal.known': 'Este problema ya se conocía y tu reporte se ha añadido a él.', 'portal.willEmail': 'Te escribiremos cuando esté resuelto.',
  'portal.follow': 'Seguir tu reporte', 'portal.followHint': 'Guarda este enlace privado para ver el progreso y hablar con el equipo.', 'portal.another': 'Informar de otra cosa',
  'portal.stepOf': "Paso {n} de 3", 'portal.step1': "Qué pasó", 'portal.step2': "Los detalles", 'portal.step3': "Cómo contactarte", 'portal.next': "Siguiente", 'portal.back': "Atrás", 'portal.titleNeeded': "Primero ponle un título corto, por ejemplo \"El botón de pago no hace nada\".", 'portal.reachHint': "Ambos son opcionales. Deja tu correo y te avisaremos cuando esté resuelto.", 'portal.privacyTitle': "Qué ve el equipo", 'portal.privacy': "Solo lo que escribes aquí, y tu nombre y correo si los añades. Si pegas un error, se guarda con él tu navegador y su versión para ayudar a reproducir el problema. Tu dirección IP solo se usa para frenar el spam y no se guarda con tu reporte.",
  'track.unavailable': 'Este enlace de seguimiento no está disponible', 'track.unavailableHint': 'Puede que el enlace sea incorrecto o que el reporte se haya eliminado.',
  'track.yourReport': 'Tu reporte a {name}', 'track.reported': 'Enviado el {date}',
  'track.received': 'Recibido', 'track.accepted': 'Aceptado', 'track.in_progress': 'En curso', 'track.fixed': 'Resuelto', 'track.closed': 'Cerrado',
  'track.merged': 'El equipo encontró otro reporte del mismo problema; ahora se tratan juntos.',
  'track.live': 'Publicado en la versión {release}', 'track.waiting': 'Resuelto; estará disponible con la próxima versión.',
  'track.question': '¿Está resuelto para ti?', 'track.yesFixed': 'Sí, está resuelto', 'track.stillBroken': 'No, sigue fallando',
  'track.thanksFixed': '¡Gracias por confirmarlo!', 'track.thanksBroken': 'Gracias por avisarnos. El equipo lo ha reabierto.',
  'track.fromEmail': 'Abriste esto desde el correo. Confírmalo aquí:',
  'track.conversation': 'Conversación con el equipo', 'track.none': 'Todavía no hay mensajes.', 'track.you': 'Tú', 'track.team': 'Equipo',
  'track.write': 'Añade detalles o haz una pregunta', 'track.send': 'Enviar',
  'roadmap.unavailable': 'Esta hoja de ruta no está disponible', 'roadmap.unavailableHint': 'Puede que el enlace sea incorrecto o que el equipo haya desactivado esta página.',
  'roadmap.title': 'Hoja de ruta de {name}', 'roadmap.planned': 'Planeado', 'roadmap.in_progress': 'En curso', 'roadmap.done': 'Hecho',
  'roadmap.vote': 'Votar', 'roadmap.voted': 'Votado', 'roadmap.votes': 'Votos: {n}', 'roadmap.empty': 'Todavía no hay nada aquí.',
  'roadmap.how': 'Un voto por elemento desde este navegador. Vuelve a pulsar para retirarlo.',
};

const fr = {
  'common.poweredBy': 'Propulsé par Tessera', 'common.language': 'Langue',
  'portal.unavailable': "Cette page de signalement n'est pas disponible",
  'portal.unavailableHint': "Le lien est peut-être incorrect, ou l'équipe a désactivé ou remplacé cette page.",
  'portal.title': 'Signaler un problème dans {name}', 'portal.bug': 'Quelque chose ne marche pas', 'portal.idea': "J'ai une idée", 'portal.bugHint': 'Une erreur ou quelque chose qui ne marche pas', 'portal.ideaHint': 'Quelque chose que vous aimeriez voir',
  'portal.what': "Que s'est-il passé ?", 'portal.whatPlaceholder': 'Le bouton de paiement ne fait rien',
  'portal.details': 'Détails', 'portal.detailsHint': "Qu'avez-vous fait, qu'attendiez-vous et que s'est-il passé à la place ?",
  'portal.pasteError': "Coller un message d'erreur (facultatif)", 'portal.errorPlaceholder': "Copiez-le depuis l'écran ou la console du navigateur", 'portal.errorLabel': "Message d'erreur",
  'portal.name': 'Votre nom (facultatif)', 'portal.email': 'E-mail (facultatif)', 'portal.emailHint': 'Pour vous prévenir quand ce sera corrigé.',
  'portal.send': 'Envoyer le signalement', 'portal.thanks': "Merci, l'équipe de {name} a reçu votre signalement", 'portal.reference': 'Votre référence est',
  'portal.known': 'Ce problème était déjà connu et votre signalement y a été ajouté.', 'portal.willEmail': 'Nous vous écrirons quand ce sera corrigé.',
  'portal.follow': 'Suivre votre signalement', 'portal.followHint': "Gardez ce lien privé pour suivre l'avancement et échanger avec l'équipe.", 'portal.another': 'Signaler autre chose',
  'portal.stepOf': "Étape {n} sur 3", 'portal.step1': "Ce qui s'est passé", 'portal.step2': "Les détails", 'portal.step3': "Comment vous joindre", 'portal.next': "Suivant", 'portal.back': "Retour", 'portal.titleNeeded': "Donnez-lui d'abord un titre court, par exemple « Le bouton de paiement ne fait rien ».", 'portal.reachHint': "Les deux sont facultatifs. Laissez un e-mail et nous vous préviendrons quand ce sera corrigé.", 'portal.privacyTitle': "Ce que voit l'équipe", 'portal.privacy': "Seulement ce que vous écrivez ici, et votre nom et votre e-mail si vous les ajoutez. Si vous collez une erreur, votre navigateur et sa version sont gardés avec elle pour aider à reproduire le problème. Votre adresse IP sert uniquement à bloquer le spam et n'est pas enregistrée avec votre signalement.",
  'track.unavailable': "Ce lien de suivi n'est pas disponible", 'track.unavailableHint': 'Le lien est peut-être incorrect, ou le signalement a été supprimé.',
  'track.yourReport': 'Votre signalement à {name}', 'track.reported': 'Envoyé le {date}',
  'track.received': 'Reçu', 'track.accepted': 'Accepté', 'track.in_progress': 'En cours', 'track.fixed': 'Corrigé', 'track.closed': 'Fermé',
  'track.merged': "L'équipe a trouvé un autre signalement du même problème ; ils sont maintenant traités ensemble.",
  'track.live': 'Publié dans la version {release}', 'track.waiting': 'Corrigé ; ce sera en ligne avec la prochaine version.',
  'track.question': 'Est-ce corrigé pour vous ?', 'track.yesFixed': "Oui, c'est corrigé", 'track.stillBroken': 'Non, ça ne marche toujours pas',
  'track.thanksFixed': 'Merci de votre confirmation !', 'track.thanksBroken': "Merci de nous l'avoir dit. L'équipe l'a rouvert.",
  'track.fromEmail': "Vous avez ouvert ceci depuis l'e-mail. Confirmez ici :",
  'track.conversation': "Conversation avec l'équipe", 'track.none': 'Pas encore de messages.', 'track.you': 'Vous', 'track.team': 'Équipe',
  'track.write': 'Ajoutez des détails ou posez une question', 'track.send': 'Envoyer',
  'roadmap.unavailable': "Cette feuille de route n'est pas disponible", 'roadmap.unavailableHint': "Le lien est peut-être incorrect, ou l'équipe a désactivé cette page.",
  'roadmap.title': 'Feuille de route de {name}', 'roadmap.planned': 'Prévu', 'roadmap.in_progress': 'En cours', 'roadmap.done': 'Terminé',
  'roadmap.vote': 'Voter', 'roadmap.voted': 'Voté', 'roadmap.votes': 'Votes : {n}', 'roadmap.empty': "Rien ici pour l'instant.",
  'roadmap.how': 'Un vote par élément depuis ce navigateur. Cliquez à nouveau pour le retirer.',
};

const de = {
  'common.poweredBy': 'Bereitgestellt mit Tessera', 'common.language': 'Sprache',
  'portal.unavailable': 'Diese Meldeseite ist nicht verfügbar',
  'portal.unavailableHint': 'Der Link ist vielleicht falsch, oder das Team hat diese Seite abgeschaltet oder ersetzt.',
  'portal.title': 'Ein Problem in {name} melden', 'portal.bug': 'Etwas funktioniert nicht', 'portal.idea': 'Ich habe eine Idee', 'portal.bugHint': 'Ein Fehler oder etwas, das nicht funktioniert', 'portal.ideaHint': 'Etwas, das Sie sich wünschen',
  'portal.what': 'Was ist passiert?', 'portal.whatPlaceholder': 'Der Bezahlen-Knopf tut nichts',
  'portal.details': 'Details', 'portal.detailsHint': 'Was haben Sie getan, was haben Sie erwartet, und was ist stattdessen passiert?',
  'portal.pasteError': 'Fehlermeldung einfügen (optional)', 'portal.errorPlaceholder': 'Vom Bildschirm oder aus der Browser-Konsole kopieren', 'portal.errorLabel': 'Fehlermeldung',
  'portal.name': 'Ihr Name (optional)', 'portal.email': 'E-Mail (optional)', 'portal.emailHint': 'Damit wir Ihnen sagen können, wenn es behoben ist.',
  'portal.send': 'Meldung senden', 'portal.thanks': 'Danke, das {name}-Team hat Ihre Meldung erhalten', 'portal.reference': 'Ihre Referenz ist',
  'portal.known': 'Dieses Problem war schon bekannt, und Ihre Meldung wurde hinzugefügt.', 'portal.willEmail': 'Wir schreiben Ihnen, sobald es behoben ist.',
  'portal.follow': 'Meldung verfolgen', 'portal.followHint': 'Bewahren Sie diesen privaten Link auf, um den Fortschritt zu sehen und mit dem Team zu sprechen.', 'portal.another': 'Etwas anderes melden',
  'portal.stepOf': "Schritt {n} von 3", 'portal.step1': "Was passiert ist", 'portal.step2': "Die Details", 'portal.step3': "Wie wir Sie erreichen", 'portal.next': "Weiter", 'portal.back': "Zurück", 'portal.titleNeeded': "Geben Sie zuerst einen kurzen Titel ein, zum Beispiel „Der Bezahlen-Knopf tut nichts“.", 'portal.reachHint': "Beides ist freiwillig. Mit einer E-Mail-Adresse sagen wir Ihnen, wenn es behoben ist.", 'portal.privacyTitle': "Was das Team sieht", 'portal.privacy': "Nur, was Sie hier schreiben, und Ihren Namen und Ihre E-Mail-Adresse, wenn Sie sie angeben. Wenn Sie eine Fehlermeldung einfügen, werden Ihr Browser und seine Version mit ihr gespeichert, damit das Problem nachgestellt werden kann. Ihre IP-Adresse dient nur zum Schutz vor Spam und wird nicht mit Ihrer Meldung gespeichert.",
  'track.unavailable': 'Dieser Link ist nicht verfügbar', 'track.unavailableHint': 'Der Link ist vielleicht falsch, oder die Meldung wurde entfernt.',
  'track.yourReport': 'Ihre Meldung an {name}', 'track.reported': 'Gesendet am {date}',
  'track.received': 'Eingegangen', 'track.accepted': 'Angenommen', 'track.in_progress': 'In Arbeit', 'track.fixed': 'Behoben', 'track.closed': 'Geschlossen',
  'track.merged': 'Das Team hat eine weitere Meldung zum selben Problem gefunden; beide werden jetzt gemeinsam bearbeitet.',
  'track.live': 'Veröffentlicht in Version {release}', 'track.waiting': 'Behoben; ab der nächsten Version verfügbar.',
  'track.question': 'Ist es für Sie behoben?', 'track.yesFixed': 'Ja, es ist behoben', 'track.stillBroken': 'Nein, es geht immer noch nicht',
  'track.thanksFixed': 'Danke für die Bestätigung!', 'track.thanksBroken': 'Danke für den Hinweis. Das Team hat es wieder geöffnet.',
  'track.fromEmail': 'Sie haben dies aus der E-Mail geöffnet. Bitte hier bestätigen:',
  'track.conversation': 'Unterhaltung mit dem Team', 'track.none': 'Noch keine Nachrichten.', 'track.you': 'Sie', 'track.team': 'Team',
  'track.write': 'Details ergänzen oder eine Frage stellen', 'track.send': 'Senden',
  'roadmap.unavailable': 'Diese Roadmap ist nicht verfügbar', 'roadmap.unavailableHint': 'Der Link ist vielleicht falsch, oder das Team hat diese Seite abgeschaltet.',
  'roadmap.title': 'Roadmap von {name}', 'roadmap.planned': 'Geplant', 'roadmap.in_progress': 'In Arbeit', 'roadmap.done': 'Erledigt',
  'roadmap.vote': 'Abstimmen', 'roadmap.voted': 'Abgestimmt', 'roadmap.votes': 'Stimmen: {n}', 'roadmap.empty': 'Noch nichts hier.',
  'roadmap.how': 'Eine Stimme pro Eintrag aus diesem Browser. Erneut klicken, um sie zurückzunehmen.',
};

const hi = {
  'common.poweredBy': 'Tessera द्वारा संचालित', 'common.language': 'भाषा',
  'portal.unavailable': 'यह रिपोर्ट पेज उपलब्ध नहीं है',
  'portal.unavailableHint': 'लिंक गलत हो सकता है, या टीम ने यह पेज बंद कर दिया है या बदल दिया है।',
  'portal.title': '{name} में समस्या की रिपोर्ट करें', 'portal.bug': 'कुछ काम नहीं कर रहा', 'portal.idea': 'मेरे पास एक सुझाव है', 'portal.bugHint': 'कोई गड़बड़ी या कुछ जो ठीक से काम नहीं कर रहा', 'portal.ideaHint': 'कुछ ऐसा जो आप चाहते हैं कि यह करे',
  'portal.what': 'क्या हुआ?', 'portal.whatPlaceholder': 'भुगतान बटन कुछ नहीं करता',
  'portal.details': 'विवरण', 'portal.detailsHint': 'आपने क्या किया, आप क्या उम्मीद कर रहे थे, और इसके बजाय क्या हुआ?',
  'portal.pasteError': 'त्रुटि संदेश चिपकाएँ (वैकल्पिक)', 'portal.errorPlaceholder': 'इसे स्क्रीन या ब्राउज़र कंसोल से कॉपी करें', 'portal.errorLabel': 'त्रुटि संदेश',
  'portal.name': 'आपका नाम (वैकल्पिक)', 'portal.email': 'ईमेल (वैकल्पिक)', 'portal.emailHint': 'ठीक होने पर आपको बताने के लिए।',
  'portal.send': 'रिपोर्ट भेजें', 'portal.thanks': 'धन्यवाद, {name} टीम को आपकी रिपोर्ट मिल गई है', 'portal.reference': 'आपका संदर्भ है',
  'portal.known': 'यह समस्या पहले से ज्ञात थी, और आपकी रिपोर्ट उसमें जोड़ दी गई है।', 'portal.willEmail': 'ठीक होने पर हम आपको ईमेल करेंगे।',
  'portal.follow': 'अपनी रिपोर्ट देखें', 'portal.followHint': 'प्रगति देखने और टीम से बात करने के लिए यह निजी लिंक सँभालकर रखें।', 'portal.another': 'कुछ और रिपोर्ट करें',
  'portal.stepOf': "चरण {n} / 3", 'portal.step1': "क्या हुआ", 'portal.step2': "विवरण", 'portal.step3': "आपसे संपर्क", 'portal.next': "आगे", 'portal.back': "पीछे", 'portal.titleNeeded': "पहले एक छोटा शीर्षक लिखें, जैसे \"भुगतान बटन कुछ नहीं करता\"।", 'portal.reachHint': "दोनों वैकल्पिक हैं। ईमेल दें, तो ठीक होने पर हम आपको बताएँगे।", 'portal.privacyTitle': "टीम क्या देखती है", 'portal.privacy': "सिर्फ़ वही जो आप यहाँ लिखते हैं, और आपका नाम व ईमेल अगर आप जोड़ें। अगर आप कोई त्रुटि संदेश चिपकाते हैं, तो समस्या दोहराने में मदद के लिए आपके ब्राउज़र का नाम और संस्करण उसके साथ रखा जाता है। आपका IP पता सिर्फ़ स्पैम रोकने के लिए इस्तेमाल होता है और आपकी रिपोर्ट के साथ सहेजा नहीं जाता।",
  'track.unavailable': 'यह ट्रैकिंग लिंक उपलब्ध नहीं है', 'track.unavailableHint': 'लिंक गलत हो सकता है, या रिपोर्ट हटा दी गई है।',
  'track.yourReport': '{name} को आपकी रिपोर्ट', 'track.reported': '{date} को भेजी गई',
  'track.received': 'मिल गई', 'track.accepted': 'स्वीकार की गई', 'track.in_progress': 'इस पर काम चल रहा है', 'track.fixed': 'ठीक हो गई', 'track.closed': 'बंद',
  'track.merged': 'टीम को इसी समस्या की एक और रिपोर्ट मिली; अब दोनों पर साथ में काम हो रहा है।',
  'track.live': 'संस्करण {release} में जारी', 'track.waiting': 'ठीक हो गई; अगले संस्करण के साथ उपलब्ध होगी।',
  'track.question': 'क्या यह आपके लिए ठीक हो गया?', 'track.yesFixed': 'हाँ, ठीक हो गया', 'track.stillBroken': 'नहीं, अभी भी खराब है',
  'track.thanksFixed': 'पुष्टि करने के लिए धन्यवाद!', 'track.thanksBroken': 'बताने के लिए धन्यवाद। टीम ने इसे फिर से खोल दिया है।',
  'track.fromEmail': 'आपने इसे ईमेल से खोला है। कृपया यहाँ पुष्टि करें:',
  'track.conversation': 'टीम के साथ बातचीत', 'track.none': 'अभी कोई संदेश नहीं।', 'track.you': 'आप', 'track.team': 'टीम',
  'track.write': 'विवरण जोड़ें या प्रश्न पूछें', 'track.send': 'भेजें',
  'roadmap.unavailable': 'यह रोडमैप उपलब्ध नहीं है', 'roadmap.unavailableHint': 'लिंक गलत हो सकता है, या टीम ने यह पेज बंद कर दिया है।',
  'roadmap.title': '{name} रोडमैप', 'roadmap.planned': 'योजना में', 'roadmap.in_progress': 'काम जारी', 'roadmap.done': 'पूरा',
  'roadmap.vote': 'वोट दें', 'roadmap.voted': 'वोट दिया', 'roadmap.votes': 'वोट: {n}', 'roadmap.empty': 'अभी यहाँ कुछ नहीं है।',
  'roadmap.how': 'इस ब्राउज़र से हर आइटम पर एक वोट। वापस लेने के लिए फिर से क्लिक करें।',
};

const bn = {
  'common.poweredBy': 'Tessera দ্বারা চালিত', 'common.language': 'ভাষা',
  'portal.unavailable': 'এই রিপোর্ট পেজটি পাওয়া যাচ্ছে না',
  'portal.unavailableHint': 'লিংকটি ভুল হতে পারে, অথবা দল এই পেজটি বন্ধ করেছে বা বদলে দিয়েছে।',
  'portal.title': '{name}-এ সমস্যা জানান', 'portal.bug': 'কিছু কাজ করছে না', 'portal.idea': 'আমার একটা ভাবনা আছে', 'portal.bugHint': 'কোনো ত্রুটি বা এমন কিছু যা ঠিকমতো কাজ করছে না', 'portal.ideaHint': 'এমন কিছু যা আপনি চান এটি করুক',
  'portal.what': 'কী হয়েছে?', 'portal.whatPlaceholder': 'পেমেন্ট বোতামে কিছুই হয় না',
  'portal.details': 'বিস্তারিত', 'portal.detailsHint': 'আপনি কী করেছিলেন, কী আশা করেছিলেন, আর তার বদলে কী হলো?',
  'portal.pasteError': 'ত্রুটির বার্তা পেস্ট করুন (ঐচ্ছিক)', 'portal.errorPlaceholder': 'স্ক্রিন বা ব্রাউজার কনসোল থেকে কপি করুন', 'portal.errorLabel': 'ত্রুটির বার্তা',
  'portal.name': 'আপনার নাম (ঐচ্ছিক)', 'portal.email': 'ইমেল (ঐচ্ছিক)', 'portal.emailHint': 'ঠিক হলে আপনাকে জানানোর জন্য।',
  'portal.send': 'রিপোর্ট পাঠান', 'portal.thanks': 'ধন্যবাদ, {name} দল আপনার রিপোর্ট পেয়েছে', 'portal.reference': 'আপনার রেফারেন্স হলো',
  'portal.known': 'এই সমস্যাটি আগে থেকেই জানা ছিল, আর আপনার রিপোর্ট তার সঙ্গে যোগ করা হয়েছে।', 'portal.willEmail': 'ঠিক হলে আমরা আপনাকে ইমেল করব।',
  'portal.follow': 'আপনার রিপোর্ট দেখুন', 'portal.followHint': 'অগ্রগতি দেখতে আর দলের সঙ্গে কথা বলতে এই ব্যক্তিগত লিংকটি রেখে দিন।', 'portal.another': 'অন্য কিছু জানান',
  'portal.stepOf': "ধাপ {n} / ৩", 'portal.step1': "কী হয়েছে", 'portal.step2': "বিস্তারিত", 'portal.step3': "যোগাযোগ", 'portal.next': "পরবর্তী", 'portal.back': "পিছনে", 'portal.titleNeeded': "আগে একটা ছোট শিরোনাম দিন, যেমন \"পেমেন্ট বোতামে কিছুই হয় না\"।", 'portal.reachHint': "দুটোই ঐচ্ছিক। ইমেল দিলে ঠিক হলে আমরা আপনাকে জানাব।", 'portal.privacyTitle': "দল কী দেখতে পায়", 'portal.privacy': "শুধু আপনি এখানে যা লেখেন, আর আপনার নাম ও ইমেল যদি দেন। কোনো ত্রুটির বার্তা দিলে, সমস্যাটা আবার ঘটিয়ে দেখতে সাহায্যের জন্য আপনার ব্রাউজারের নাম ও সংস্করণ তার সঙ্গে রাখা হয়। আপনার IP ঠিকানা শুধু স্প্যাম আটকাতে ব্যবহার হয় এবং রিপোর্টের সঙ্গে সংরক্ষণ করা হয় না।",
  'track.unavailable': 'এই ট্র্যাকিং লিংকটি পাওয়া যাচ্ছে না', 'track.unavailableHint': 'লিংকটি ভুল হতে পারে, অথবা রিপোর্টটি সরিয়ে ফেলা হয়েছে।',
  'track.yourReport': '{name}-কে আপনার রিপোর্ট', 'track.reported': '{date} তারিখে পাঠানো',
  'track.received': 'পাওয়া গেছে', 'track.accepted': 'গৃহীত', 'track.in_progress': 'কাজ চলছে', 'track.fixed': 'ঠিক হয়েছে', 'track.closed': 'বন্ধ',
  'track.merged': 'দল একই সমস্যার আরেকটি রিপোর্ট পেয়েছে; এখন দুটোর কাজ একসঙ্গে হচ্ছে।',
  'track.live': '{release} সংস্করণে প্রকাশিত', 'track.waiting': 'ঠিক হয়েছে; পরের সংস্করণে চালু হবে।',
  'track.question': 'আপনার জন্য কি ঠিক হয়েছে?', 'track.yesFixed': 'হ্যাঁ, ঠিক হয়েছে', 'track.stillBroken': 'না, এখনও কাজ করছে না',
  'track.thanksFixed': 'নিশ্চিত করার জন্য ধন্যবাদ!', 'track.thanksBroken': 'জানানোর জন্য ধন্যবাদ। দল এটি আবার খুলেছে।',
  'track.fromEmail': 'আপনি এটি ইমেল থেকে খুলেছেন। অনুগ্রহ করে এখানে নিশ্চিত করুন:',
  'track.conversation': 'দলের সঙ্গে কথোপকথন', 'track.none': 'এখনও কোনো বার্তা নেই।', 'track.you': 'আপনি', 'track.team': 'দল',
  'track.write': 'বিস্তারিত যোগ করুন বা প্রশ্ন করুন', 'track.send': 'পাঠান',
  'roadmap.unavailable': 'এই রোডম্যাপটি পাওয়া যাচ্ছে না', 'roadmap.unavailableHint': 'লিংকটি ভুল হতে পারে, অথবা দল এই পেজটি বন্ধ করেছে।',
  'roadmap.title': '{name} রোডম্যাপ', 'roadmap.planned': 'পরিকল্পিত', 'roadmap.in_progress': 'কাজ চলছে', 'roadmap.done': 'সম্পন্ন',
  'roadmap.vote': 'ভোট দিন', 'roadmap.voted': 'ভোট দিয়েছেন', 'roadmap.votes': 'ভোট: {n}', 'roadmap.empty': 'এখনও এখানে কিছু নেই।',
  'roadmap.how': 'এই ব্রাউজার থেকে প্রতিটি আইটেমে একটি ভোট। ফিরিয়ে নিতে আবার ক্লিক করুন।',
};

export const LANGUAGES = [
  ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['hi', 'हिन्दी'], ['bn', 'বাংলা'],
];
const DICTS = { en, es, fr, de, hi, bn };
const KEY = 'tessera.publicLang';

function initialLang() {
  try { const saved = localStorage.getItem(KEY); if (DICTS[saved]) return saved; } catch { /* storage blocked */ }
  const browser = (navigator.languages ?? [navigator.language]).map((l) => String(l).slice(0, 2).toLowerCase()).find((l) => DICTS[l]);
  return browser ?? 'en';
}

// [t, lang, setLang]: t('portal.title', { name }) fills {name}; a missing key falls back to English.
export function usePublicLang() {
  const [lang, setLangState] = useState(initialLang);
  const setLang = (l) => { setLangState(l); try { localStorage.setItem(KEY, l); } catch { /* storage blocked */ } };
  const t = (key, vars = {}) => translate(lang, key, vars);
  return [t, lang, setLang];
}

// The same lookup without the remembered choice (the landing page's demo switches languages
// without changing what the real public pages will open in).
export const translate = (lang, key, vars = {}) => ((DICTS[lang] ?? en)[key] ?? en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

export const formatDay = (date, lang) => new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(date));

// Every language has every key (checked in development so a missing one is noticed).
if (import.meta.env.DEV) {
  for (const [code, dict] of Object.entries(DICTS)) {
    const missing = Object.keys(en).filter((k) => !(k in dict));
    if (missing.length) console.warn(`i18n: ${code} is missing ${missing.join(', ')}`);
  }
}
