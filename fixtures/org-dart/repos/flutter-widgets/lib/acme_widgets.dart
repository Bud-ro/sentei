// Entry library of acme_widgets: Flutter widgets for acme_flutter_app.
import 'package:flutter/material.dart';

// Expected: alive, no finding (acme_flutter_app's main builds it).
class AcmeButton extends StatelessWidget {
  const AcmeButton({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => ElevatedButton(onPressed: null, child: Text(label));
}

// Expected: deletion_candidate ["no_refs"] (exported, no org package uses it).
class AcmeBanner extends StatelessWidget {
  const AcmeBanner({super.key});

  @override
  Widget build(BuildContext context) => const MaterialBanner(content: Text('acme'), actions: [SizedBox.shrink()]);
}
