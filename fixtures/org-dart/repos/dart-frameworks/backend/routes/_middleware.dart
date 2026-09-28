import 'package:dart_frog/dart_frog.dart';

// Expected: no finding. dart_frog applies `middleware` of routes/**/_middleware.dart.
Handler middleware(Handler handler) => handler;
