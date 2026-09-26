// Entry point of acme_flutter_app (lib/main.dart, run by the Flutter engine).
import 'package:acme_widgets/acme_widgets.dart';
import 'package:flutter/material.dart';

// Expected: alive, no finding (Flutter runtime entry: nothing references it).
void main() => runApp(const MaterialApp(home: AcmeButton(label: 'Go')));
